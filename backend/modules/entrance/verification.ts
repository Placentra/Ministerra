// VERIFICATION MODULE ==========================================================
// Email verification for new users and account credentials changes.
// =============================================================================

import { nanoid } from 'nanoid';
import { jwtQuickies } from '../jwtokens';
import sendEmail from '../mailing';
import { getLogger } from '../../systems/handlers/logging/index';
import { EXPIRATIONS } from '../../../shared/constants';

const logger = getLogger('Entrance:Verification');

let redis;
// REDIS CLIENT SETTER ----------------------------------------------------------
// Verification uses redis for short-lived codes and email-change state.
const setRedis = r => (redis = r);

// VERIFY NEW USER EMAIL ---------------------------
// VERIFY MAIL --------------------------------------------------------------
// Steps: mark user as unintroduced, mint an opaque verifyCode, store it in redis with TTL, then redirect client into introduction flow using the code (not raw JWT).
async function verifyMail({ userID }, con) {
	await con.execute(/*sql*/ `UPDATE users SET status = "unintroduced" WHERE id = ?`, [userID]);
	const verifyCode = nanoid(32),
		expiry = Date.now() + EXPIRATIONS.verifyMailLink; // GENERATE SHORT-LIVED VERIFICATION CODE ---
	await redis.setex(`verifyCode:${verifyCode}`, 1800, `${userID}:unintroduced:${expiry}`);
	return { redirect: `${process.env.FRONT_END}/entrance?mode=introduction&code=${verifyCode}` };
}

// VERIFY NEW EMAIL (AFTER EMAIL CHANGE) ---------------------------
// VERIFY NEW MAIL -----------------------------------------------------------
// Steps: read pending new_mail/prev_mail, atomically commit users.email change, update change-tracking state, optionally send revert link to prev_mail, then redirect.
async function verifyNewMail({ userID }, con) {
	try {
		const [[{ new_mail, prev_mail }]] = await con.execute(/*sql*/ `SELECT prev_mail, new_mail, mail_at FROM changes_tracking WHERE user = ?`, [userID]);
		if (!new_mail) throw new Error('badRequest');
		await con.beginTransaction();
		await con.execute(/*sql*/ `UPDATE users SET email = ? WHERE id = ?`, [new_mail, userID]);
		await con.execute(/*sql*/ `UPDATE changes_tracking SET ${prev_mail ? 'mail_at = NOW()' : 'new_mail = NULL, prev_mail = NULL, mail_at = NULL'} WHERE user = ?`, [userID]);
		if (prev_mail)
			await sendEmail({
				mode: 'revertEmailChange',
				token: `${jwtQuickies({ mode: 'create', payload: { userID, is: 'revertEmailChange' }, expiresIn: EXPIRATIONS.revertEmailChangeLink })}:${
					Date.now() + EXPIRATIONS.revertEmailChangeLink
				}`,
				email: prev_mail,
			});
		await con.commit();
	} catch (error) {
		await con.rollback();
		logger.error('verifyNewMail', { error, userID });
		throw new Error('verifyNewMailFailed');
	}
	return { redirect: `${process.env.FRONT_END}/entrance?mess=newMailVerified` };
}

export { verifyMail, verifyNewMail, setRedis };
