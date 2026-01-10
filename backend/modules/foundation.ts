// FOUNDATION MODULE ------------------------------------------------------------
// Provides a single "bootstrap" endpoint for clients to load:
// - auth rotation + device salt
// - notification dots
// - user interaction deltas
// - content metas for visible cities

// IMPORTS ----------------------------------------------------------------------
import { Sql, Catcher } from '../systems/systems.ts';
import { getLogger } from '../systems/handlers/loggers.ts';
import { getAuth } from '../utilities/helpers/auth.ts';
import { getDeviceSalt } from '../utilities/helpers/device.ts';
import Alerts from './alerts.ts';

// SUBMODULES -------------------------------------------------------------------
import { setRedis, resolveDeviceSync, persistDeviceSync } from './foundation/utils.ts';
import { syncUserData } from './foundation/userSync.ts';
import { processContentMetas } from './foundation/content.ts';

const logger = getLogger('Foundation');
// REDIS CLIENT SETTER ----------------------------------------------------------
// Foundation delegates redis usage to submodules; this keeps wiring centralized.
const ioRedisSetter = redisClient => setRedis(redisClient);

// FOUNDATION HANDLER ----------------------------------------------------------

// FOUNDATION ---
// Steps: derive auth/security material first, then resolve + persist sync watermarks, then fetch content metas for the requested cities, then assemble one response payload (including notif dots) so the client can render immediately.
// FOUNDATION DISPATCHER --------------------------------------------------------
// Orchestrates the full load flow; keeps ordering explicit so sync watermarks are correct.
async function Foundation(req, res) {
	let con = null;
	const { userID, is, devID, devIsStable, load, getCities = [], cities = [], gotKey, clientEpoch, deviceID } = req.body;
	const authLoads = new Set(['init', 'fast', 'auth']);

	try {
		const oldUserUnstableDev = is !== 'newUser' && !devIsStable;

		// 1. AUTHENTICATION & SECURITY --------------------------------------------
		// Steps: mint/rotate auth only when client doesn’t already have a key; do it early so later work can include device salt where needed.
		const authData = !gotKey && authLoads.has(load) ? getAuth(userID, { clientEpoch }) : null;

		// NOTIF DOTS ------------------------------------------------------------
		// Steps: fetch dots early; fall back to zeros so a sub-failure doesn’t block core content load.
		let notifDots;
		try {
			notifDots = await Alerts({ body: { userID, mode: 'getNotifDots' } });
		} catch (alertsErr) {
			logger.error('Foundation Alerts failed', { error: alertsErr, userID });
			notifDots = { chats: 0, alerts: 0, archive: 0, lastSeenAlert: 0 };
		}

		// DEVICE SALT -----------------------------------------------------------
		// Steps: only hit SQL for device salt when auth rotation happened and a deviceID is present (keeps cost bounded).
		let deviceSalt = null;
		if (authData && deviceID) {
			con = con || (await Sql.getConnection());
			deviceSalt = await getDeviceSalt(con, userID, deviceID);
		}

		// AUTH-ONLY RESPONSE ----------------------------------------------------
		// Steps: short-circuit to keep auth refresh fast; include previous auth so clients can roll safely across rotation boundaries.
		if (load === 'auth') {
			return res.status(200).json({
				unstableDev: oldUserUnstableDev,
				notifDots,
				...(authData
					? {
							auth: authData.auth,
							authEpoch: authData.epoch,
							authExpiry: authData.expiry,
							...(deviceSalt && { deviceSalt }),
							...(authData.previousAuth && { previousAuth: authData.previousAuth, previousEpoch: authData.previousEpoch }),
					  }
					: {}),
			});
		}

		// 2. DATA SYNCHRONIZATION -------------------------------------------------
		// Steps: clamp sync timestamps, run sync only for init/fast/auth loads, then persist updated watermarks so subsequent calls can be delta-based.
		let [{ lastDevSync: devSync = 0, lastLinksSync: linksSync = 0 }, user, interactions, delInteractions] = [req.body, null, {}, {}];

		// SYNC WATERMARKS -------------------------------------------------------
		// Steps: normalize client-provided timestamps into server-accepted values to prevent rewinds and out-of-order device sync.
		devSync = await resolveDeviceSync(userID, devID, devSync);
		linksSync = Number(linksSync) || 0;

		if (authLoads.has(load)) {
			// USER SYNC -----------------------------------------------------------
			// Steps: pull deltas since devSync/linksSync; return new watermarks; unstable devices get guarded behavior.
			const syncResult = await syncUserData(req, con, { userID, load, devID, devSync, linksSync, oldUserUnstableDev });
			user = syncResult.user;
			interactions = syncResult.interactions;
			delInteractions = syncResult.delInteractions;
			devSync = syncResult.devSync;
			linksSync = syncResult.linksSync;

			// PERSIST WATERMARKS --------------------------------------------------
			// Steps: persist after successful sync so retries don’t advance watermarks without delivering the payload.
			await persistDeviceSync(userID, devID, devSync, linksSync);
		}

		// 3. CONTENT METADATA -----------------------------------------------------
		// Steps: fetch event/user metas for requested cities; this is independent of sync so home refresh can do it without re-syncing.
		const {
			contentMetas,
			citiesData,
			contSync = Date.now(),
		} = await processContentMetas({
			con,
			load,
			getCities,
			cities,
			userID,
		});

		// 4. RESPONSE ASSEMBLY ----------------------------------------------------
		// Steps: assemble one stable response shape; include auth fields only when a new auth was minted.
		res.json({
			contentMetas,
			citiesData,
			user,
			interactions,
			delInteractions,
			contSync,
			devSync,
			linksSync,
			notifDots,
			unstableDev: oldUserUnstableDev,
			...(authData
				? {
						auth: authData.auth,
						authEpoch: authData.epoch,
						authExpiry: authData.expiry,
						...(deviceSalt && { deviceSalt }),
						...(authData.previousAuth && { previousAuth: authData.previousAuth, previousEpoch: authData.previousEpoch }),
				  }
				: {}),
		});
	} catch (error) {
		logger.error('Foundation', { error, userID, load });
		Catcher({ origin: 'Foundation', error, res });
	} finally {
		if (con) con.release();
	}
}

export { Foundation, ioRedisSetter };
