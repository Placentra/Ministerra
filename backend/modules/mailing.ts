import nodemailer from 'nodemailer';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { getLogger } from '../systems/handlers/loggers.ts';

// MAILING MODULE ---------------------------------------------------------------
// Sends transactional emails via AWS SES v2 (through nodemailer transport).
// Used by entrance flows (verify/reset/change email) and account actions.

const logger = getLogger('Mailing'),
	[b, f] = ['BACK_END', 'FRONT_END'];

// SES V2 CLIENT + TRANSPORTER -------------------------------------------------
// nodemailer 7.x expects: { SES: { sesClient, SendEmailCommand } }
const sesClient = new SESv2Client({
	region: process.env.AWS_SES_REGION || 'eu-central-1',
	credentials: {
		accessKeyId: process.env.AWS_ACCESS!,
		secretAccessKey: process.env.AWS_SECRET!,
	},
});

const transporter = nodemailer.createTransport({
	SES: { sesClient, SendEmailCommand },
} as any);

// MODE CONFIGURATION ----------------------------------------------------------
const modes = {
	freezeUser: { subject: 'Zmrazení účtu', content: 'Pro autorizaci zmrazení účtu klikni na tento odkaz >>>', link: b },
	deleteUser: { subject: 'Smazání účtu', content: 'Pro autorizaci smazání účtu klikni na tento odkaz >>>', link: b },
	passChanged: { subject: 'Heslo změněno', content: 'Tvoje heslo bylo úspěšně změněno.' },
	bothChanged: { subject: 'Email a heslo změněny', content: 'Tvoje emailová adresa a heslo k účtu bylo úspěšně změněno' },
	mailChanged: { subject: 'Email byl změněn', content: 'Tvoje emailová adresa k tvému účtu byla úspěšně změněna' },
	resetPass: { subject: 'Reset hesla', content: 'Pro změnu hesla klikni na tento odkaz >>>', link: f },
	changePass: { subject: 'Změna hesla', content: 'Pro změnu hesla klikni na tento odkaz >>>', link: f },
	changeMail: { subject: 'Změna emailu', content: 'Pro změnu emailu klikni na tento odkaz >>>', link: f },
	changeBoth: { subject: 'Změna emailu a hesla', content: 'Pro změnu emailu a hesla klikni na tento odkaz >>>', link: f },
	revertEmailChange: {
		link: f,
		subject: 'Vrácení změny emailu',
		content: 'Někdo změnil emailovou adresu k tvému účtu. Pokud jsi to byl ty, ignoruj tento email. Pokud ne, klikni na tento odkaz pro vrácení původního emailu >>>',
	},
	verifyMail: { subject: 'Verifikace emailu >>> Nastavení profilu', content: 'Nyní tě čeká konfigurace profilu (cca 2 minuty), nejdříve však potvrď svůj email >>>', link: b },
	verifyNewMail: { subject: 'Verifikace nového emailu', content: 'Pro potvrzení nového emailu klikni na tento odkaz >>>', link: b },
};

// SEND EMAIL HANDLER ----------------------------------------------------------
export default async function sendEmail({ mode, email, token = '' }: any) {
	// Skip email when SES not configured ---
	if (!process.env.APP_EMAIL || !process.env.AWS_ACCESS || !process.env.AWS_SECRET) return;

	const m = modes[mode];
	if (!m) {
		logger.error('sendEmail: unknown mode', { mode });
		return;
	}

	try {
		const linkUrl = m.link ? `${process.env[m.link]}/entrance?mode=${mode}&auth=${token}` : '';
		const textContent = m.link ? `${m.content} ${linkUrl}` : m.content;

		await transporter.sendMail({
			from: `"ProWision network>>>" <${process.env.APP_EMAIL}>`,
			to: email,
			subject: m.subject,
			text: textContent,
		});
	} catch (error) {
		logger.error('sendEmail', { error, mode });
		throw new Error('serverError');
	}
}
