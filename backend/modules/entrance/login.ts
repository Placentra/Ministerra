import bcrypt from 'bcrypt';
import { jwtQuickies } from '../jwtokens.ts';
import { getAuth } from '../../utilities/helpers/auth.ts';
import { registerDevice } from '../../utilities/helpers/device.ts';
import { getLogger } from '../../systems/handlers/loggers.ts';
import { REDIS_KEYS } from '../../../shared/constants.ts';

const logger = getLogger('Entrance:Login');
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
				`UPDATE logins SET last_seen = NOW(), ip_addresses = JSON_MERGE_PATCH(COALESCE(ip_addresses, '{}'), JSON_OBJECT(?, COALESCE(JSON_EXTRACT(ip_addresses, ?), 0) + 1)), count = count + 1${sets} WHERE user = ? AND (last_seen IS NULL OR TIMESTAMPDIFF(MINUTE, last_seen, NOW()) > 10)`,
				[ip, `$."${ip}"`, userID]
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
export async function login({ email, pass, print }, con) {
	if (print?.length < 8 || print?.length > 128) throw new Error('invalidDevicePrint');

	let frozen = false;
	const loginCols = 'id, created, pass, flag, cities, status';
	const getUserQ = table => `SELECT ${loginCols} FROM ${table} WHERE email = ? LIMIT 1`;

	// USER LOOKUP -------------------------------------------------------------
	// Steps: try users first, then fro_users; we treat fro_users as recoverable state when user logs back in.
	let [[u]] = await con.execute(getUserQ('users'), [email]);
	if (!u && ([[u]] = await con.execute(getUserQ('fro_users'), [email]))) frozen = true;

	// CREDENTIAL CHECK --------------------------------------------------------
	// Steps: fail fast without leaking extra info; bcrypt compare is the canonical guard.
	if (!u) throw new Error('userNotFound');
	if (!(await bcrypt.compare(pass, u.pass))) throw new Error('wrongLogin');

	// STATUS BRANCHES ---------------------------------------------------------
	// Steps: return sentinel payloads so the frontend can enter verify/intro flows without full auth issuance.
	if (u.status === 'verifyMail') return { payload: 'verifyMail' };

	if (frozen) {
		await con.execute(`UPDATE fro_users SET flag = "unf" WHERE id = ?`, [u.id]);
		return { payload: 'unfreezing' };
	}

	// FROZEN FLAG REPAIR ------------------------------------------------------
	// Steps: if flag was set but tasks haven’t reconciled yet, clear it so the session can proceed normally.
	if (u.flag === 'fro') await con.execute(`UPDATE users SET flag = "ok" WHERE id = ?`, [u.id]);

	if (u.status === 'unintroduced')
		return { payload: { status: u.status, authToken: `${jwtQuickies({ mode: 'create', payload: { userID: u.id, is: 'unintroduced' }, expiresIn: '30m' })}:${Date.now() + 18e5}` } };

	const auth = getAuth(u.id),
		dev = await registerDevice(con, u.id, print);
	return {
		jwtData: { is: u.status, create: 'both', userID: u.id, print },
		payload: {
			auth: auth.auth,
			authEpoch: auth.epoch,
			authExpiry: auth.expiry,
			deviceID: dev.deviceID,
			deviceSalt: dev.salt,
			deviceKey: dev.deviceKey,
			cities: u.cities,
			...(auth.previousAuth && { previousAuth: auth.previousAuth, previousEpoch: auth.previousEpoch }),
		},
	};
}

// LOGOUT HELPERS --------------------------------------------------------------
// Steps: delete refresh tokens (redis + SQL), then disconnect sockets best-effort; caller decides single device vs “everywhere”.
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
	const [[{ pass: h }]] = await con.execute(`SELECT pass FROM users WHERE id = ? LIMIT 1`, [userID]);
	if (!(await bcrypt.compare(pass, h))) throw new Error('wrongPass');
	await logoutUserDevices({ userID, devID, excludeCurrentDevice: true, reason: 'logout', con });
	return { payload: 'loggedOutEverywhere' };
}
