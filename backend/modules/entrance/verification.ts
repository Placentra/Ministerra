// VERIFICATION MODULE ==========================================================
// Email verification for new users and account credentials changes.
// =============================================================================

import { jwtQuickies } from '../jwtokens.ts';
import sendEmail from '../mailing.ts';
import { getLogger } from '../../systems/handlers/loggers.ts';
import { EXPIRATIONS } from '../../../shared/constants.ts';

import { Redis } from 'ioredis';

const logger = getLogger('Entrance:Verification');

let redis: Redis | null = null;
// REDIS CLIENT SETTER ----------------------------------------------------------
// Verification uses redis for short-lived codes and email-change state.
const setRedis = (r: Redis | null): Redis | null => (redis = r);

interface VerifyMailProps {
	userID: string | number;
}

interface VerifyResult {
	redirect: string;
}

// VERIFY NEW USER EMAIL ---------------------------
// VERIFY MAIL --------------------------------------------------------------
// Steps: mark user as unintroduced, mint a short-lived auth token, then redirect to frontend setup flow with the token embedded in URL.
async function verifyMail({ userID }: VerifyMailProps, con: any): Promise<VerifyResult> {
	await con.execute(/*sql*/ `UPDATE users SET status = "unintroduced" WHERE id = ?`, [userID]);
	// MINT AUTH TOKEN FOR FRONTEND ---
	// Frontend stores this in sessionStorage and proceeds to /setup for profile configuration.
	const authToken: string = jwtQuickies({ mode: 'create', payload: { userID, is: 'unintroduced' }, expiresIn: '30m' });
	const expiry: number = Date.now() + 30 * 60 * 1000;
	return { redirect: `${process.env.FRONT_END}/entrance?mode=introduction&auth=${authToken}:${expiry}` };
}

// VERIFY NEW EMAIL (AFTER EMAIL CHANGE) ---------------------------
// VERIFY NEW MAIL -----------------------------------------------------------
// Steps: read pending new_mail/prev_mail, atomically commit users.email change, update change-tracking state, optionally send revert link to prev_mail, then redirect.
async function verifyNewMail({ userID }: VerifyMailProps, con: any): Promise<VerifyResult> {
	try {
		const [[{ new_mail, prev_mail }]]: [any[], any] = await con.execute(/*sql*/ `SELECT prev_mail, new_mail, mail_at FROM changes_tracking WHERE user = ?`, [userID]);
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
	} catch (error: any) {
		await con.rollback();
		logger.error('verifyNewMail', { error, userID });
		throw new Error('verifyNewMailFailed');
	}
	return { redirect: `${process.env.FRONT_END}/entrance?mess=newMailVerified` };
}

export { verifyMail, verifyNewMail, setRedis };
