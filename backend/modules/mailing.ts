import nodemailer from 'nodemailer';
import * as aws from '@aws-sdk/client-sesv2';
import { getLogger } from '../systems/handlers/logging/index';

// MAILING MODULE ---------------------------------------------------------------
// Sends transactional emails via AWS SES (through nodemailer transport).
// Used by entrance flows (verify/reset/change email) and account actions.

const logger = getLogger('Mailing'),
	SESClient = new aws.SESv2Client({ region: 'eu-central-1', credentials: { accessKeyId: process.env.AWS_ACCESS, secretAccessKey: process.env.AWS_SECRET } }),
	transporter = (nodemailer.createTransport({ SES: { SESClient, aws } } as any) as any);

// CONFIGURATION ---------------------------------------------------------------

const modes = {
	freezeUser: { s: 'Zmrazení účtu', t: 'Pro autorizaci zmrazení účtu klikni na tento odkaz >>>', p: 1, b: 1 },
	deleteUser: { s: 'Smazání účtu', t: 'Pro autorizaci smazání účtu klikni na tento odkaz >>>', p: 1, b: 1 },
	passChanged: { s: 'Heslo změněno', t: 'Tvoje heslo bylo úspěšně změněno.', n: 1 },
	bothChanged: { s: 'Email a heslo změněny', t: 'Tvoje emailová adresa a heslo k účtu bylo úspěšně změněno', n: 1 },
	mailChanged: { s: 'Email byl změněn', t: 'Tvoje emailová adresa k tvému účtu byla úspěšně změněna', n: 1 },
	resetPass: { s: 'Reset hesla', t: 'Pro změnu hesla klikni na tento odkaz >>>', p: 1 },
	changePass: { s: 'Změna hesla', t: 'Pro změnu hesla klikni na tento odkaz >>>', p: 1 },
	changeMail: { s: 'Změna emailu', t: 'Pro změnu emailu klikni na tento odkaz >>>', p: 1 },
	changeBoth: { s: 'Změna emailu a hesla', t: 'Pro změnu emailu a hesla klikni na tento odkaz >>>', p: 1 },
	revertEmailChange: {
		s: 'Vrácení změny emailu',
		t: 'Někdo změnil emailovou adresu k tvému účtu. Pokud jsi to byl ty, ignoruj tento email. Pokud ne, klikni na tento odkaz pro vrácení původního emailu >>>',
		p: 1,
		// No 'b' flag means it defaults to FRONT_END URL
	},
	verifyMail: { s: 'Verifikace emailu >>> Nastavení profilu', t: 'Nyní tě čeká konfigurace profilu (cca 2 minuty), nejdříve však potvrď svůj email >>>', b: 1 },
	verifyNewMail: { s: 'Verifikace nového emailu', t: 'Pro potvrzení nového emailu klikni na tento odkaz >>>', b: 1 },
};

// MAILING HANDLER -------------------------------------------------------------

// SEND EMAIL ---
// Steps: pick template by mode, then send via SES-backed nodemailer transport with bounded retries and exponential backoff for transient failures.
export default async function sendEmail({ mode, email, token = '' }: any) {
	const m = modes[mode];
	// RETRY LOOP ------------------------------------------------------------
	// Steps: attempt up to 3 times; retry only on transient network/throttling errors so we don’t spam SES on permanent failures.
	for (let i = 0; i < 3; i++) {
		try {
			// PAYLOAD BUILD ------------------------------------------------------
			// Steps: compose link using BACK_END or FRONT_END based on template flags; when `n` is set, this is a notification-only email without link.
			await transporter.sendMail({
				from: `"ProWision network>>>" <${process.env.APP_EMAIL}>`,
				to: email,
				subject: m.s,
				text: `${m.t} ${m.n ? '' : `${process.env[m.b ? 'BACK_END' : 'FRONT_END']}/entrance?${m.p ? `mode=${mode}&` : ''}auth=${token}`}`,
				ses: { Tags: [{ Name: 'type', Value: mode }] },
			} as any);
			return;
		} catch (e) {
			// ERROR HANDLING -----------------------------------------------------
			// Steps: fail fast on final attempt or non-transient errors; otherwise back off and retry.
			if (i === 2 || !['Throttling', 'ServiceUnavailable', 'RequestTimeout', 'NetworkingError', 'ECONNRESET', 'ETIMEDOUT'].some(c => (e?.code || e?.name || e?.message || '').includes(c))) {
				logger.error('sendEmail', { error: e, mode, email });
				throw new Error('serverError');
			}
			await new Promise(r => setTimeout(r, 1000 * 2 ** i));
		}
	}
}
