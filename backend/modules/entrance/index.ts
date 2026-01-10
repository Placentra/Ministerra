import { Sql, Catcher } from '../../systems/systems.ts';
import { jwtCreate, jwtQuickies } from '../jwtokens.ts';

// SUBMODULE IMPORTS -----------------------------------------------------------
import { register, resendMail, setRedis as setRegisterRedis } from './register.ts';
import { login, logoutDevice, logoutEverywhere, updateLoginsTable, setRedis as setLoginRedis, setSocketIO as setLoginSocketIO } from './login.ts';
import { forgotPass, changeCredentials, revertEmailChange } from './credentials.ts';
import { verifyMail, verifyNewMail, setRedis as setVerificationRedis } from './verification.ts';
import { delFreezeUser, setRedis as setAccountRedis } from './accountActions.ts';

// REDIS CLIENT SETTER ----------------------------------------------------------
// Steps: inject shared redis into submodules so each stays testable and we avoid importing a singleton directly.
const ioRedisSetter = redisClient => {
	setRegisterRedis(redisClient);
	setLoginRedis(redisClient);
	setVerificationRedis(redisClient);
	setAccountRedis(redisClient);
};

// SOCKET SETTER ----------------------------------------------------------------
// Steps: inject socket io into login module so logout flows can disconnect active sessions best-effort.
const socketSetter = io => {
	setLoginSocketIO(io);
};

// PROCESSORS --------------------------------------------
const processors = {
	register,
	resendMail,
	login,
	logoutDevice,
	logoutEverywhere,
	verifyMail,
	verifyNewMail,
	freezeUser: delFreezeUser,
	deleteUser: delFreezeUser,
	forgotPass,
	resetPass: forgotPass,
	changeMail: changeCredentials,
	changePass: changeCredentials,
	changeBoth: changeCredentials,
	revertEmailChange,
};

// PROPS VALIDATIONS ---------------------------------
const propsAreInvalid = {
	changeBoth: ({ pass, newPass, newEmail, is }) => (is !== 'changeBoth' ? !pass || !newEmail : !pass || !newPass),
	changePass: ({ pass, newPass, is }) => (is !== 'changePass' ? !pass : !pass || !newPass),
	changeMail: ({ pass, newEmail }) => !pass || !newEmail, // newEmail always required ---
	forgotPass: ({ email }) => !email,
	resetPass: ({ newPass }) => !newPass,
	login: ({ pass, email, print }) => !pass || !email || !print,
	register: ({ pass, email }) => !pass || !email,
	logoutEverywhere: ({ pass, userID, devID }) => !pass || !userID || !devID,
	logoutDevice: ({ userID, devID }) => !userID || !devID,
	freezeUser: ({ is, pass }) => (is ? false : !pass),
	deleteUser: ({ pass, is }) => (is ? false : !pass),
	resendMail: ({ mailType, email, pass }) => !email || (mailType === 'verifyMail' && !pass),
	verifyMail: () => false,
	verifyNewMail: () => false,
	revertEmailChange: ({ pass }) => !pass,
	default: () => true,
};

// ENTRANCE DISPATCHER ----------------------------------------------------------
// Steps: optionally verify email-link auth token, validate props for (mode||is), run processor under one SQL connection, then mint tokens / clear cookies / redirect as requested.
async function Entrance(req, res) {
	let con;
	try {
		// AUTH CHECK ---
		// Steps: allow auth via query/body for email-link flows; if missing, remove is so processors don’t assume confirmed state.
		if (req.query.auth || req.body.auth) Object.assign(req.body, jwtQuickies({ mode: 'verify', payload: (req.query.auth || req.body.auth).split(':')[0] }));
		else delete req.body.is;

		const { mode, is, userID, devID } = req.body;

		// RENEW TOKEN ----------------------------------------------------------
		// Steps: short-circuit renewAccessToken to avoid touching processors map; this keeps token refresh fast and predictable.
		if (mode === 'renewAccessToken') {
			if (!userID) return res.status(401).json({ error: 'unauthorized' });
			await jwtCreate({ res, create: 'access', userID, is, deviceInfo: { devID } });
			return res.status(200).end();
		}
		if (mode === 'register') req.body.ip = req.ip;

		// VALIDATION -----------------------------------------------------------
		// Steps: validate required props based on mode/is so processors can assume shape; reject early with badRequest.
		if ((propsAreInvalid[mode || is] ?? propsAreInvalid.default)(req.body)) throw new Error('badRequest');

		con = await Sql.getConnection();
		const { jwtData, redirect, payload, clearRefreshCookie } = (await processors[mode || is](req.body, con)) || {};

		// RESPONSE -------------------------------------------------------------
		// Steps: mint JWTs when processor returned jwtData, optionally clear refresh cookie, then respond as redirect/json/end based on payload type.
		if (jwtData) await jwtCreate({ res, con, ...jwtData });
		if (clearRefreshCookie) res.clearCookie('rJWT', { path: '/', httpOnly: true, sameSite: 'strict', signed: true, secure: true });
		res.status(200)[redirect ? 'redirect' : typeof payload === 'object' ? 'json' : 'end'](redirect || payload);
	} catch (error) {
		Catcher({ origin: 'entrance', error, res, context: { mode: req.body?.mode, is: req.body?.is } });
	} finally {
		if (con) con.release();
	}
}

export { updateLoginsTable, Entrance, ioRedisSetter, socketSetter };
