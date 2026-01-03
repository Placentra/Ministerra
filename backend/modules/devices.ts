import { Sql } from '../systems/systems.ts';
import { listDevices, revokeDevice, renameDevice } from '../utilities/helpers/device.ts';
import { getLogger } from '../systems/handlers/logging/index.ts';
import { invalidateCacheForDevice } from './jwtokens.ts';
import { REDIS_KEYS } from '../../shared/constants.ts';

const logger = getLogger('Devices');

let redis;
const ioRedisSetter = redisClient => (redis = redisClient);

// DEVICES HANDLER -------------------------------------------------------------

/** ----------------------------------------------------------------------------
 * DEVICES
 * Manages per-device encryption salts for isolated device security.
 * Provides list, revoke, and rename operations.
 * -------------------------------------------------------------------------- */
async function Devices(req, res) {
	let con = null;
	const { userID, mode, deviceID, name } = req.body;

	if (!userID) return res.status(400).json({ error: 'Missing userID' });

	try {
		// CONNECTION ----------------------------------------------------------
		// Steps: open SQL connection once; device operations are DB-backed and shouldn’t run without a connection.
		con = await Sql.getConnection();

		switch (mode) {
			case 'list': {
				// LIST DEVICES ------------------------------------------------------
				// Steps: read device rows, normalize/label fields for frontend, and mark current device based on request payload.
				const devices = await listDevices(con, userID);
				const formatted = devices.map(d => ({
					id: d.device_id,
					name: d.name || 'Neznámé zařízení',
					fingerprintHash: d.fingerprint_hash,
					createdAt: d.created_at,
					lastSeen: d.last_seen,
					isRevoked: Boolean(d.is_revoked),
					isCurrent: d.device_id === req.body.currentDeviceID,
				}));
				return res.json({ devices: formatted });
			}

			case 'revoke': {
				// REVOKE DEVICE -----------------------------------------------------
				// Steps: mark revoked in SQL, delete refresh token entry in redis (best-effort), then invalidate in-process JWT cache so access checks converge quickly.
				if (!deviceID) return res.status(400).json({ error: 'Missing deviceID' });
				await revokeDevice(con, userID, deviceID);

				if (redis) {
					try {
						await redis.hdel(REDIS_KEYS.refreshTokens, `${userID}_${deviceID}`);
					} catch (redisErr) {
						logger.alert('Failed to invalidate refresh token in Redis', { userID, deviceID, error: redisErr?.message });
					}
				}
				invalidateCacheForDevice(userID, deviceID);
				logger.info('Device revoked', { userID, deviceID });
				return res.json({ success: true });
			}

			case 'rename': {
				// RENAME DEVICE -----------------------------------------------------
				// Steps: validate input, update DB, and return success; cache consistency is handled by listDevices reading from SQL.
				if (!deviceID || !name) return res.status(400).json({ error: 'Missing deviceID or name' });
				await renameDevice(con, userID, deviceID, name);
				return res.json({ success: true });
			}

			default:
				return res.status(400).json({ error: 'Invalid mode' });
		}
	} catch (error) {
		logger.error('Devices', { error, userID, mode });
		res.status(500).json({ error: 'Server error' });
	} finally {
		// CLEANUP -------------------------------------------------------------
		// Steps: release connection even on early returns inside switch.
		if (con) con.release();
	}
}

export default Devices;
export { ioRedisSetter };
