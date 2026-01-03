// ACCOUNT ACTIONS MODULE =======================================================
// Delete user, freeze user, and related cleanup operations.
// =============================================================================

import bcrypt from 'bcrypt';
import { decode } from 'cbor-x';
import { jwtQuickies } from '../jwtokens';
import sendEmail from '../mailing';
import { logoutUserDevices } from './login';
import { getStateVariables, processOrpEveMetas, loadMetaPipes, clearState } from '../../utilities/contentHelpers';
import { getLogger } from '../../systems/handlers/logging/index';

const logger = getLogger('Entrance:AccountActions');

let redis;
const setRedis = r => (redis = r);

// DELETE OR FREEZE USER ---------------------------
// Steps: first request confirms password and sends an email link; second request (JWT-confirmed) flips user flag, orphans events, revokes sessions, then rewrites orphaned event metas in redis.
async function delFreezeUser({ pass, userID, mode, is }, con) {
	const [[{ email: currentEmail, pass: storedPass } = {}]] = await con.execute(/*sql*/ `SELECT email, pass FROM users WHERE id = ?`, [userID]);

	// FIRST STEP (REQUEST) ---------------------------------------------------
	// Steps: validate password, then email a short-lived confirmation link; nothing is mutated yet.
	if (mode !== is) {
		if (!(await bcrypt.compare(pass, storedPass))) throw new Error('wrongPass');
		await sendEmail({ mode, token: `${jwtQuickies({ mode: 'create', payload: { userID, is: mode } })}:${Date.now() + 60 * 1000 * 5}`, email: currentEmail });
		return { payload: 'mailSent' };
	}

	// SECOND STEP (CONFIRMED VIA JWT) ----------------------------------------
	// Steps: apply flag change + owner rewrite in one transaction, revoke sessions, then commit; redis/meta rebuild happens after commit (best-effort).
	try {
		await con.beginTransaction();
		await con.execute(/*sql*/ `UPDATE users SET flag = ${is === 'deleteUser' ? "'del'" : "'fro'"} WHERE id = ?`, [userID]);
		await con.execute(/*sql*/ `UPDATE events SET owner = ? WHERE owner = ?`, [`orp_${userID}`, userID]);
		// LOGOUT USER FROM ALL DEVICES WITHIN TRANSACTION ---
		await logoutUserDevices({ userID, excludeCurrentDevice: false, reason: is === 'deleteUser' ? 'accountDeleted' : 'accountFrozen', con });
		await con.commit();
	} catch (error) {
		await con.rollback();
		logger.error('delFreezeUser', { error, userID });
		throw new Error('accountUpdateFailed');
	}

	// ORPHANED EVENTS META REWRITE -------------------------------------------
	// Steps: find orphaned event ids, decode cached metas, run orphan-processor, then fill content pipeline so feeds stop attributing events to deleted/frozen user.
	try {
		const [rows] = await con.execute(/*sql*/ `SELECT id FROM events WHERE owner = ?`, [`orp_${userID}`]);
		const orphanedIds = rows.map(r => r.id);
		if (orphanedIds.length) {
			const state = getStateVariables(),
				metasBuffer = await redis.hmgetBuffer('eveMetas', ...orphanedIds);
			const data = metasBuffer
				.map((meta, idx) => {
					try {
						return meta ? [orphanedIds[idx], decode(meta)] : null;
					} catch {
						return null;
					}
				})
				.filter(Boolean);
			processOrpEveMetas({ data, state });
			const metasTxn = redis.multi();
			loadMetaPipes(state, metasTxn, metasTxn), await metasTxn.exec(), clearState(state);
		}
	} catch (error) {
		logger.error('delFreezeUser', { error, userID, step: 'processOrphanedEvents' });
	}

	const mess = is === 'deleteUser' ? 'userDeleted' : 'userFrozen';
	return { redirect: `${process.env.FRONT_END}/entrance?mess=${mess}` };
}

export { delFreezeUser, setRedis };
