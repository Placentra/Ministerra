import { getLogger } from './loggers';

// ERROR STATUS MAP -------------------------------------------------------------
// Normalizes backend error codes into HTTP status codes.
// This keeps module handlers free to throw string codes instead of manually mapping status.
const errorStatus = {
	unauthorized: 401,
	tokenExpired: 401,
	badRequest: 400,
	userNotFound: 404,
	notFound: 404,
	serverError: 500,
	mailTaken: 409,
	blocked: 403,
	missingData: 400,
	validationError: 422,
	rateLimited: 429,
	conflict: 409,
	forbidden: 403,
	noUpdate: 400,
	alreadyLinked: 400,
	tooManyLinkRequest: 403,
	emailChangeActive: 403,
	noActiveEmailChange: 400,
	emailMismatch: 400,
	emailReverted: 200,
	logout: 401,
	badPayload: 400,
	missingUser: 400,
	invalidMembers: 400,
	invalidChatName: 400,
	emptyMessage: 400,
	noVIPMember: 400,
	noAdminMember: 400,
	tooLate: 400,
	cannotLeavePrivateChat: 400,
	missingDeviceFingerprint: 400,
	weakPass: 400,
	newMailSameAsCurrent: 400,
	personalsChangeTooRecent: 400,
	ageAlreadyChanged: 400,
	unknownMode: 400,
	noRedisConnection: 503,
	invalidImage: 400,
	imageTooLarge: 400,
	messagePostFailed: 500,
	registrationFailed: 500,
	revertEmailFailed: 500,
	verifyNewMailFailed: 500,
	accountUpdateFailed: 500,
	eventCreateFailed: 500,
	chatCreateFailed: 500,
	chatSetupFailed: 500,
	chatLeaveFailed: 500,
	chatEndFailed: 500,
	userLinkUpdateFailed: 500,
	userTrustsUpdateFailed: 500,
	userBlockUpdateFailed: 500,
	cannotEndPrivateChat: 400,
};

// FRIENDLY MESSAGE MAP ---------------------------------------------------------
// Converts internal error codes into user-facing Czech messages.
// Only include messages that are safe to display to end users (no secrets, no stack traces).
const friendlyMessages = {
	unauthorized: 'Nemáte oprávnění k této akci.',
	tokenExpired: 'Vaše přihlášení vypršelo. Přihlaste se prosím znovu.',
	logout: 'Byli jste odhlášeni. Přihlaste se prosím znovu.',
	badRequest: 'Neplatný požadavek. Zkontrolujte údaje a zkuste to znovu.',
	serverError: 'Na serveru došlo k chybě. Zkuste to prosím znovu.',
	mailTaken: 'Tento e-mail už používá jiný účet.',
	weakPass: 'Heslo musí mít minimálně 8 znaků, jedno velké písmeno, číslo a speciální znak.',
	userNotFound: 'Účet se zadanými údaji nebyl nalezen.',
	wrongLogin: 'Nesprávný e-mail nebo heslo.',
	wrongPass: 'Nesprávné heslo.',
	newMailSameAsCurrent: 'Nový e-mail se nesmí shodovat s aktuálním.',
	emailChangeActive: 'Změna e-mailu je už v procesu. Zkontrolujte prosím svou schránku.',
	noActiveEmailChange: 'Nemáme zaznamenanou žádnou aktivní změnu e-mailu.',
	emailMismatch: 'Zadané e-maily se neshodují.',
	emailReverted: 'Změna e-mailu byla vrácena.',
	missingDeviceFingerprint: 'Chybí identifikace zařízení. Aktualizujte stránku a zkuste to znovu.',
	missingData: 'Chybí požadovaná data.',
	validationError: 'Odeslaná data nejsou platná.',
	rateLimited: 'Odesíláte příliš mnoho požadavků. Zkuste to znovu později.',
	conflict: 'Akci nebylo možné dokončit kvůli konfliktu.',
	forbidden: 'Tuto akci není možné provést.',
	noUpdate: 'Nebyla provedena žádná změna.',
	alreadyLinked: 'Uživatel je už propojen.',
	tooManyLinkRequest: 'Dosáhli jste limitu žádostí. Zkuste to znovu později.',
	badPayload: 'Odeslaná data mají neplatný formát.',
	missingUser: 'Chybí cílový uživatel.',
	noRedisConnection: 'Interní služba není dostupná. Zkuste to později.',
	unknownMode: 'Neznámý typ požadavku.',
	invalidMembers: 'Seznam členů chatu je neplatný.',
	invalidChatName: 'Název chatu musí mít alespoň dva znaky.',
	emptyMessage: 'Zpráva musí obsahovat text.',
	noVIPMember: 'VIP chat musí mít alespoň jednoho VIP člena.',
	noAdminMember: 'Skupinový chat musí mít alespoň jednoho správce.',
	messagePostFailed: 'Zprávu se nepodařilo odeslat. Zkuste to znovu.',
	tooLate: 'Časový limit pro tuto akci vypršel.',
	cannotLeavePrivateChat: 'Soukromý chat nelze opustit.',
	blocked: 'Uživatel je blokovaný.',
	invalidImage: 'Obrázek má neplatný formát.',
	imageTooLarge: 'Obrázek je příliš velký (max. 5 MB).',
	ageAlreadyChanged: 'Věk jste upravili nedávno. Zkuste to za 120 dní.',
	personalsChangeTooRecent: 'Osobní údaje lze upravit jen jednou za čas. Zkuste to později.',
	'not owner': 'Nejste vlastníkem této položky.',
	'daily limit reached': 'Dosáhli jste denního limitu. Zkuste to znovu později.',
	registrationFailed: 'Registraci se nepodařilo dokončit. Zkuste to prosím znovu.',
	revertEmailFailed: 'Nepodařilo se vrátit změnu e-mailu. Zkuste to později.',
	verifyNewMailFailed: 'Nepodařilo se ověřit nový e-mail. Zkuste to prosím znovu.',
	accountUpdateFailed: 'Nepodařilo se dokončit změnu účtu. Zkuste to později.',
	eventCreateFailed: 'Událost se nepodařilo uložit. Zkuste to prosím znovu.',
	chatCreateFailed: 'Chat se nepodařilo vytvořit. Zkuste to prosím znovu.',
	chatSetupFailed: 'Změny v chatu se nepodařilo uložit. Zkuste to znovu.',
	chatLeaveFailed: 'Opuštění chatu selhalo. Zkuste to prosím znovu.',
	chatEndFailed: 'Ukončení chatu selhalo. Zkuste to prosím znovu.',
	userLinkUpdateFailed: 'Nepodařilo se upravit spojení s uživatelem. Zkuste to znovu.',
	userTrustsUpdateFailed: 'Nepodařilo se změnit důvěrnostní vztah. Zkuste to znovu.',
	userBlockUpdateFailed: 'Nepodařilo se upravit blokování uživatele. Zkuste to prosím znovu.',
	cannotEndPrivateChat: 'Soukromý chat nelze ukončit.',
	chatMembersNotFound: 'Členové chatu nebyli nalezeni.',
};

// FALLBACK MESSAGE -------------------------------------------------------------
// Default message for unknown/untrusts error codes.
const fallbackMessage = 'Něco se pokazilo. Zkuste to prosím znovu.';

// ALIASES ----------------------------------------------------------------------
// NOTE: keep index signature friendly by using bracket assignment (TS object has fixed keys).
friendlyMessages['somethingsWrong'] = fallbackMessage;

// FRIENDLY MESSAGE RESOLUTION --------------------------------------------------
// Accepts a thrown error message/code and returns a safe user-facing message.
// Heuristic: if message looks like a readable sentence (e.g. Czech text), allow it through.
// Steps: resolve known codes first, map common prefixes to stable messages, allow readable sentences through, otherwise return fallback.
function resolveFriendlyMessage(message = '') {
	if (!message) return fallbackMessage;
	if (friendlyMessages[message]) return friendlyMessages[message];
	const normalized = String(message).toLowerCase();
	if (normalized.startsWith('unauthorized')) return friendlyMessages.unauthorized;
	if (normalized.startsWith('logout')) return friendlyMessages.logout;
	if (normalized.startsWith('tokenexpired')) return friendlyMessages.tokenExpired;
	if (normalized.includes('bad request')) return friendlyMessages.badRequest;
	// If the message looks like a readable sentence (e.g. Czech text), return as-is
	if (/\s/.test(message) && !/^[a-z0-9_-]+$/i.test(message)) return message;
	return fallbackMessage;
}

const logger = getLogger('Catcher');

// CENTRAL ERROR CATCHER --------------------------------------------------------
// Main error funnel for HTTP handlers:
// - logs the error with contextual request metadata (method/url/user)
// - translates internal codes into HTTP status + friendly message
// - optionally redirects auth-related errors for entrance flows
// Steps: log with bounded request context, map code->status, resolve friendly message, optionally redirect entrance auth errors, otherwise return JSON error envelope.
export function Catcher({ origin, error, res = null, req = null, context = null }) {
	// Log the error
	logger.error(`${origin}`, {
		error,
		origin,
		req: req ? { method: req.method, url: req.originalUrl, userId: req.body?.userID || req.user?.id } : undefined,
		context,
	});

	const code = error?.message || 'serverError';
	const friendly = resolveFriendlyMessage(code);

	let redirect;
	if (origin === 'entrance' && (code === 'tokenExpired' || code === 'unauthorized')) {
		redirect = `${process.env.FRONT_END}/entrance/?mess=${code}`;
	}

	if (res && !res.headersSent) {
		const statusCode = errorStatus[code] || 500;
		if (redirect) res.redirect(302, redirect); // Express ignores status() with redirect, use redirect(status, url) ---------------------------
		else res.status(statusCode).json({ code, message: friendly, status: statusCode, timestamp: Date.now() });
	}
}
