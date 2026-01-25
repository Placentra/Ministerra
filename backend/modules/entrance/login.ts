import bcrypt from 'bcrypt';
import { getAuth } from '../../utilities/helpers/auth.ts';
import { registerDevice } from '../../utilities/helpers/device.ts';
import { getLogger } from '../../systems/handlers/loggers.ts';
import { REDIS_KEYS } from '../../../shared/constants.ts';

const logger = getLogger('Entrance:Login');

// LOGIN IP HISTORY LIMIT -------------------------------------------------------
// Steps: cap IP count per user to prevent unbounded JSON growth.
const MAX_LOGIN_IP_ENTRIES: number = 30;
let redis, socketIO;
export const setRedis = r => (redis = r),
	setSocketIO = io => (socketIO = io);

// UPDATE LOGINS TABLE ----------------------------------------------------------
// Steps: compute derived columns from UA/time, rate-limit via redis lastLogin, update or insert into SQL logins, then persist lastLogin watermark so repeated calls stay cheap.
// Rationale: login tracking is high-frequency; early exits prevent write churn while preserving daily/weekly aggregates.
export async function updateLoginsTable(req, userID, con) {
	const ip = (req.ip || '').replace(/\./g, '_') || 'unknown',
		now = new Date(),
		hr = now.getHours(),
		day = now.getDay(),
		ua = req.headers?.['user-agent'] || '';
	const valid = c => c && /^[A-Za-z0-9_]+$/.test(c),
		qCol = c => `\`${String(c).replace(/`/g, '``')}\``;
	const cols = {
		h: `${Math.floor(hr / 3) * 3}_${Math.floor(hr / 3) * 3 + 3}`,
		d: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][day],
		dev: ua.includes('Mobile') ? 'mobile' : 'desktop',
		os: ua.includes('Android') ? 'Android' : ua.includes('Windows') ? 'Windows' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : null,
	};
	const [hQ, dQ, devQ, osQ] = [cols.h, cols.d, cols.dev, cols.os].map(c => (valid(c) ? qCol(c) : null));

	try {
		// WATERMARK CHECK ------------------------------------------------------
		// Steps: read lastLogin from summary; treat missing/old as “reactivate”, treat too-recent as “skip”.
		const last = await redis.hget(`${REDIS_KEYS.userSummary}:${userID}`, 'lastLogin'),
			time = Date.now();
		if (!last || last < time - 2592e6) await con.execute(`UPDATE logins SET inactive = FALSE WHERE user = ?`, [userID]); // 30 days
		else if (last > time - 6e5) return; // 10 mins
		// PERSIST WATERMARK ----------------------------------------------------
		// Steps: persist before SQL writes so concurrent calls converge on the same rate-limit boundary.
		await redis.hset(`${REDIS_KEYS.userSummary}:${userID}`, 'lastLogin', time);


		const sets = [hQ, dQ, devQ, osQ]
			.filter(c => c)
			.map(c => `, ${c} = ${c} + 1`)
			.join('');
		// SQL UPDATE THEN INSERT ----------------------------------------------
		// Steps: try UPDATE with 10min guard; if 0 affectedRows then INSERT IGNORE to create the row.
		const res = (
			await con.execute(
				`UPDATE logins SET last_seen = NOW(), ip_addresses = CASE WHEN JSON_LENGTH(COALESCE(ip_addresses, '{}')) >= ? THEN JSON_OBJECT(?, 1) ELSE JSON_MERGE_PATCH(COALESCE(ip_addresses, '{}'), JSON_OBJECT(?, COALESCE(JSON_EXTRACT(ip_addresses, ?), 0) + 1)) END, count = count + 1${sets} WHERE user = ? AND (last_seen IS NULL OR TIMESTAMPDIFF(MINUTE, last_seen, NOW()) > 10)`,
				[MAX_LOGIN_IP_ENTRIES, ip, ip, `$."${ip}"`, userID]
			)
		)[0];
		if (!res.affectedRows) {
			const [insCols, insVals] = [
				[hQ, dQ, devQ, osQ].filter(c => c),
				[hQ, dQ, devQ, osQ]
					.filter(c => c)
					.map(() => ', 1')
					.join(''),
			];
			await con.execute(`INSERT IGNORE INTO logins (user, last_seen, ip_addresses, count${insCols.length ? ', ' + insCols.join(', ') : ''}) VALUES (?, NOW(), JSON_OBJECT(?, 1), 1${insVals})`, [
				userID,
				ip,
			]);
		}
	} catch (error) {
		logger.error('updateLoginsTable', { error, userID });
	}
}

// LOGIN ------------------------------------------------------------------------
// Steps: validate print + credentials, branch on status (verifyMail/unintroduced/frozen), register device when needed, then return jwtData + auth payload for the dispatcher to mint cookies/tokens.
export async function login({ email, pass, print, devID }, con) {
	if (print?.length < 8 || print?.length > 128) throw new Error('invalidDevicePrint');
	if (!devID) throw new Error('missingDeviceID');

	const loginCols = 'id, created, pass, flag, cities, status';

	// USER LOOKUP -------------------------------------------------------------
	// Steps: query users table; frozen users included so they can re-enter via unfreeze flow.
	const [[u]] = await con.execute(`SELECT ${loginCols} FROM users WHERE email = ? AND flag != 'del' LIMIT 1`, [email]);

	// CREDENTIAL CHECK --------------------------------------------------------
	// Steps: fail fast without leaking extra info; bcrypt compare is the canonical guard.
	if (!u) throw new Error('userNotFound');
	if (!(await bcrypt.compare(pass, u.pass))) throw new Error('wrongLogin');

	// FROZEN USER UNFREEZE ----------------------------------------------------
	// Steps: user with flag='fro' is logging back in; mark for unfreezing, task will complete the process.
	if (u.flag === 'fro') {
		await con.execute(`UPDATE users SET flag = 'unf' WHERE id = ?`, [u.id]);
		return { payload: 'unfreezing' };
	}

	// STATUS BRANCHES ---------------------------------------------------------
	// Steps: return sentinel payloads so the frontend can enter verify/intro flows without full auth issuance.
	if (u.status === 'verifyMail') return { payload: 'verifyMail' };

	const isIntroduction = u.status === 'unintroduced';
	const auth = getAuth(u.id),
		dev = await registerDevice(con, u.id, devID);
	return {
		jwtData: { is: u.status, create: isIntroduction ? 'access' : 'both', userID: u.id, print },
		payload: {
			auth: auth.auth,
			authEpoch: auth.epoch,
			authExpiry: auth.expiry,
			deviceSalt: dev.salt,
			deviceKey: dev.deviceKey,
			pdkSalt: dev.pdkSalt,
			...(isIntroduction ? { status: u.status } : { cities: u.cities }),
			...(auth.previousAuth && { previousAuth: auth.previousAuth, previousEpoch: auth.previousEpoch }),
		},
	};
}

// LOGOUT USER DEVICES ----------------------------------------------------------
// Steps: bulk-delete matching refresh token fields, delete SQL rows, then disconnect sockets (excluding current device when requested).
export async function logoutUserDevices({ userID, devID = null, excludeCurrentDevice = true, reason = 'sessionInvalidated', con }) {
	try {
		const lua = excludeCurrentDevice
			? `local k=KEYS[1] local p=ARGV[1] local e=ARGV[2] local f=redis.call('HKEYS',k) local d=0 for _,v in ipairs(f) do if string.sub(v,1,#p)==p and v~=e then redis.call('HDEL',k,v) d=d+1 end end return d`
			: `local k=KEYS[1] local p=ARGV[1] local f=redis.call('HKEYS',k) local d=0 for _,v in ipairs(f) do if string.sub(v,1,#p)==p then redis.call('HDEL',k,v) d=d+1 end end return d`;
		await Promise.all([
			redis.eval(lua, 1, REDIS_KEYS.refreshTokens, `${userID}_`, ...(excludeCurrentDevice ? [`${userID}_${devID}`] : [])),
			con.execute(`DELETE FROM rjwt_tokens WHERE user = ?${excludeCurrentDevice ? ' AND device != ?' : ''}`, excludeCurrentDevice ? [userID, devID] : [userID]),
		]);
		if (socketIO) (await socketIO.in(userID).fetchSockets()).forEach(s => (!excludeCurrentDevice || s.handshake?.auth?.devID !== devID) && (s.emit('error', reason), s.disconnect(true)));
	} catch (error) {
		logger.error('logoutUserDevices', { error, userID, devID });
	}
}

export async function logoutDevice({ userID, devID }, con) {
	try {
		// SINGLE DEVICE LOGOUT -------------------------------------------------
		// Steps: delete the specific refresh token key, delete matching SQL row, then disconnect sockets for that device only.
		await Promise.all([redis.hdel(REDIS_KEYS.refreshTokens, `${userID}_${devID}`), con.execute('DELETE FROM rjwt_tokens WHERE user = ? AND device = ?', [userID, devID])]);
		if (socketIO) (await socketIO.in(userID).fetchSockets()).forEach(s => (s.devID || s.handshake?.auth?.devID) === devID && (s.emit('error', 'logout'), s.disconnect(true)));
	} catch (error) {
		logger.error('logoutDevice', { error, userID, devID });
	}
	return { payload: 'loggedOut', clearRefreshCookie: true };
}

export async function logoutEverywhere({ pass, devID, userID }, con) {
	// EVERYWHERE LOGOUT --------------------------------------------------------
	// Steps: confirm password, then revoke all other devices (keep current access token until caller clears cookie).
	const [[{ pass: h }]] = await con.execute(`SELECT pass FROM users WHERE id = ? AND flag NOT IN ('del', 'fro') LIMIT 1`, [userID]);
	if (!(await bcrypt.compare(pass, h))) throw new Error('wrongPass');
	await logoutUserDevices({ userID, devID, excludeCurrentDevice: true, reason: 'logout', con });
	return { payload: 'loggedOutEverywhere' };
}

// REKEY DEVICE - regenerate pdkSalt when fingerprint changes ---------------------------
// Steps: verify password, generate new pdkSalt, update DB, return salt + deviceSalt so frontend can re-derive and re-encrypt PDK.
export async function rekeyDevice({ pass, userID, devID }, con) {
	const [[user]] = await con.execute(`SELECT pass FROM users WHERE id = ? AND flag NOT IN ('del', 'fro') LIMIT 1`, [userID]);
	if (!user || !(await bcrypt.compare(pass, user.pass))) throw new Error('wrongPass');
	const crypto = await import('crypto');
	const newPdkSalt = crypto.randomBytes(32).toString('hex');
	await con.execute(`UPDATE user_devices SET pdk_salt = ? WHERE user_id = ? AND device_id = ? AND is_revoked = 0`, [newPdkSalt, userID, devID]);
	const [[device]] = await con.execute(`SELECT salt FROM user_devices WHERE user_id = ? AND device_id = ? AND is_revoked = 0`, [userID, devID]);
	return { payload: { pdkSalt: newPdkSalt, deviceSalt: device?.salt, userID } };
}
