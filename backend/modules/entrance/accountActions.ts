// ACCOUNT ACTIONS MODULE =======================================================
// Delete user, freeze user, and related cleanup operations.
// =============================================================================

import bcrypt from 'bcrypt';
import { decode } from 'cbor-x';
import { jwtQuickies } from '../jwtokens.ts';
import sendEmail from '../mailing.ts';
import { logoutUserDevices } from './login.ts';
import { getStateVariables, processOrpEveMetas, loadMetaPipes, clearState } from '../../utilities/contentHelpers.ts';
import { getLogger } from '../../systems/handlers/loggers.ts';

import { Redis } from 'ioredis';
import { REDIS_KEYS } from '../../../shared/constants.ts';

const logger = getLogger('Entrance:AccountActions');

let redis: Redis | null = null;
const setRedis = (r: Redis | null): Redis | null => (redis = r);

interface DelFreezeUserProps {
	pass: string;
	userID: string | number;
	mode: string;
	is: string;
}

interface DelFreezeUserResult {
	payload?: string;
	redirect?: string;
}

// DELETE OR FREEZE USER ---------------------------
// Steps: first request confirms password and sends an email link; second request (JWT-confirmed) flips user flag, orphans events, revokes sessions, then rewrites orphaned event metas in redis.
async function delFreezeUser({ pass, userID, mode, is }: DelFreezeUserProps, con: any): Promise<DelFreezeUserResult> {
	const [[{ email: currentEmail, pass: storedPass } = {}]]: [any[], any] = await con.execute(/*sql*/ `SELECT email, pass FROM users WHERE id = ?`, [userID]);

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
		await con.execute(/*sql*/ `UPDATE users SET flag = ${is === 'deleteUser' ? "'del'" : "'fro'"}, nextTask = "flagChanges" WHERE id = ?`, [userID]);
		await con.execute(/*sql*/ `UPDATE events SET owner = ? WHERE owner = ?`, [`orp_${userID}`, userID]);
		// LOGOUT USER FROM ALL DEVICES WITHIN TRANSACTION ---
		await logoutUserDevices({ userID, excludeCurrentDevice: false, reason: is === 'deleteUser' ? 'accountDeleted' : 'accountFrozen', con });
		await con.commit();
	} catch (error: any) {
		await con.rollback();
		logger.error('delFreezeUser', { error, userID });
		throw new Error('accountUpdateFailed');
	}

	// ORPHANED EVENTS META REWRITE -------------------------------------------
	// Steps: find orphaned event ids, decode cached metas, run orphan-processor, then fill content pipeline so feeds stop attributing events to deleted/frozen user.
	try {
		const [rows]: [any[], any] = await con.execute(/*sql*/ `SELECT id FROM events WHERE owner = ?`, [`orp_${userID}`]);
		const orphanedIds: (string | number)[] = rows.map((r: any) => r.id);
		if (orphanedIds.length && redis) {
			const state: any = getStateVariables(),
				metasBuffer: (Buffer | null)[] = await redis.hmgetBuffer(REDIS_KEYS.eveMetas, ...orphanedIds.map(String));
			const data: [string | number, any][] = metasBuffer
				.map((meta: Buffer | null, idx: number): [string | number, any] | null => {
					try {
						return meta ? [orphanedIds[idx], decode(meta)] : null;
					} catch {
						return null;
					}
				})
				.filter((item): item is [string | number, any] => item !== null);
			processOrpEveMetas({ data, state });
			const metasTxn: any = redis.multi();
			loadMetaPipes(state, metasTxn, metasTxn, undefined), await metasTxn.exec(), clearState(state);
		}
	} catch (error: any) {
		logger.error('delFreezeUser', { error, userID, step: 'processOrphanedEvents' });
	}

	const mess: string = is === 'deleteUser' ? 'userDeleted' : 'userFrozen';
	return { redirect: `${process.env.FRONT_END}/entrance?mess=${mess}` };
}

export { delFreezeUser, setRedis };
