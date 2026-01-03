// CREDENTIAL CHANGES MODULE ====================================================
// Password reset, email change, password change, credential verification.
// =============================================================================

import bcrypt from 'bcrypt';
import { jwtQuickies } from '../jwtokens';
import sendEmail from '../mailing';
import { checkIfMailTaken } from './register';
import { getLogger } from '../../systems/handlers/logging/index';
import { EXPIRATIONS, REVERT_EMAIL_DAYS } from '../../../shared/constants';
const logger = getLogger('Entrance:Credentials');

// FORGOT PASSWORD ---------------------------
/** Two-step password reset: send link or finalize new password */
// Steps: if request is unauthenticated, verify email exists and send reset token; if request is via JWT (is=resetPass), update password and notify via email.
async function forgotPass({ email, newPass, userID, is }, con) {
	if (is !== 'resetPass') {
		const [[userExists]] = await con.execute('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
		if (!userExists) throw new Error('userNotFound');
		await sendEmail({
			token: `${jwtQuickies({ mode: 'create', payload: { userID: userExists.id, is: 'resetPass', expiresIn: EXPIRATIONS.authToken } })}:${Date.now() + EXPIRATIONS.authToken}`,
			email,
			mode: 'resetPass',
		});
	} else {
		const [[{ email: userEmail } = {}]] = await con.execute('SELECT email FROM users WHERE id = ?', [userID]);
		await con.execute('UPDATE users SET pass = ? WHERE id = ?', [await bcrypt.hash(newPass, 10), userID]);
		await sendEmail({ mode: 'passChanged', email: userEmail });
	}
}

// CHANGE CREDENTIALS (EMAIL/PASSWORD) ---------------------------
// Steps: verify password, validate new email if present, then either (a) send verification mail(s) for the requested mode, or (b) commit changes after JWT-confirmed second step.
const getAuthToken = payload => `${jwtQuickies({ mode: 'create', payload })}:${Date.now() + EXPIRATIONS.authToken}`;
async function changeCredentials({ is, userID, mode, pass, newPass, newEmail, hasAccessToCurMail }, con) {
	const [[{ email: currentEmail, pass: storedPass } = {}]] = await con.execute(/*sql*/ `SELECT email, pass FROM users WHERE id = ?`, [userID]);
	if (!(await bcrypt.compare(pass, storedPass))) throw new Error('wrongPass');
	if (newEmail) {
		if (newEmail === currentEmail) throw new Error('newMailSameAsCurrent');
		await checkIfMailTaken(newEmail, con);
	}

	// FIRST STEP (REQUEST) ---------------------------------------------------
	// Steps: when mode != is, we’re not yet confirmed by email; write pending change state (email modes) and send an email link to prove control.
	if (mode !== is) {
		if (mode === 'changeMail') {
			if (!newEmail) throw new Error('badRequest'); // newEmail is required ---
			// EMAIL CHANGE COOLDOWN ---------------------------------------------
			// Steps: block repeat changes within window to reduce account takeover surface and support revert semantics.
			if ((await con.execute(/*sql*/ `SELECT prev_mail FROM changes_tracking WHERE user = ? AND mail_at > DATE_SUB(NOW(), INTERVAL 7 DAY) LIMIT 1`, [userID]))[0][0]?.prev_mail)
				throw new Error('emailChangeActive');
			await con.execute(/*sql*/ `INSERT INTO changes_tracking (user, prev_mail, new_mail) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE prev_mail = VALUES(prev_mail), new_mail = VALUES(new_mail)`, [
				userID,
				currentEmail,
				newEmail,
			]);
			// VERIFICATION ROUTING ----------------------------------------------
			// Steps: send to the email the user can currently access; this prevents lockout when current email is compromised.
			const targetEmail = hasAccessToCurMail ? currentEmail : newEmail;
			await sendEmail({ mode: 'verifyNewMail', token: getAuthToken({ userID, is: mode }), email: targetEmail });
		} else if (mode === 'changePass') await sendEmail({ mode, token: getAuthToken({ userID, is: mode }), email: currentEmail });
		else if (mode === 'changeBoth') {
			if (
				(await con.execute(/*sql*/ `SELECT prev_mail FROM changes_tracking WHERE user = ? AND mail_at > DATE_SUB(NOW(), INTERVAL ${REVERT_EMAIL_DAYS} DAY) LIMIT 1`, [userID]))[0][0]?.prev_mail
			)
				throw new Error('emailChangeActive');
			await con.execute(/*sql*/ `INSERT INTO changes_tracking (user, prev_mail, new_mail) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE prev_mail = VALUES(prev_mail), new_mail = VALUES(new_mail)`, [
				userID,
				currentEmail,
				newEmail,
			]);
			await sendEmail({ mode, token: getAuthToken({ userID, is: mode }), email: currentEmail });
		}
		return { payload: 'mailSent' };
	}
	// SECOND STEP (CONFIRMED VIA JWT) ----------------------------------------
	// Steps: apply the requested change now that the user clicked the email link; emit “changed” emails where appropriate.
	if (is === 'changePass') {
		await con.execute(/*sql*/ `UPDATE users SET pass = ? WHERE id = ?`, [await bcrypt.hash(newPass, 10), userID]);
		await sendEmail({ mode: 'passChanged', email: currentEmail });
		return { payload: 'changeSuccess' };
	}
	if (is === 'changeBoth') {
		await con.execute(/*sql*/ `UPDATE users SET pass = ? WHERE id = ?`, [await bcrypt.hash(newPass, 10), userID]);
		const [[{ new_mail }]] = await con.execute(/*sql*/ `SELECT new_mail FROM changes_tracking WHERE user = ?`, [userID]);
		await sendEmail({ mode: 'passChanged', email: currentEmail });
		await sendEmail({ mode: 'verifyNewMail', token: getAuthToken({ userID, is: 'verifyNewMail' }), email: new_mail });
		return { payload: 'verifyNewMailSent' };
	}
	return { payload: 'changeSuccess' };
}

// REVERT EMAIL CHANGE ---------------------------
// Steps: confirm password, ensure there is an active change window, then atomically restore prev_mail and clear change-tracking state.
async function revertEmailChange({ userID, pass }, con) {
	const [[{ pass: storedPass } = {}]] = await con.execute('SELECT pass, email FROM users WHERE id = ?', [userID]);
	if (!(await bcrypt.compare(pass, storedPass))) throw new Error('wrongPass');

	const [[emailChange]] = await con.execute(/*sql*/ `SELECT prev_mail, new_mail FROM changes_tracking WHERE user = ? AND mail_at > DATE_SUB(NOW(), INTERVAL ${REVERT_EMAIL_DAYS} DAY)`, [userID]);
	if (!emailChange) throw new Error('noActiveEmailChange');

	try {
		await con.beginTransaction();
		await con.execute(/*sql*/ `UPDATE users SET email = ? WHERE id = ?`, [emailChange.prev_mail, userID]);
		await con.execute(/*sql*/ `UPDATE changes_tracking SET mail_at = NULL, new_mail = NULL, prev_mail = NULL WHERE user = ?`, [userID]);
		await con.commit();
	} catch (error) {
		await con.rollback();
		logger.error('revertEmailChange', { error, userID });
		throw new Error('revertEmailFailed');
	}
	return { payload: 'emailReverted' };
}

export { forgotPass, changeCredentials, revertEmailChange };
