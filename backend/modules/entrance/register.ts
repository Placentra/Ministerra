// REGISTRATION MODULE -----------------------------------------------------------
// User registration, email validation, rate limiting, and verification emails.

import bcrypt from 'bcrypt';
import { nanoid } from 'nanoid';
import { jwtQuickies } from '../jwtokens';
import sendEmail from '../mailing';
import { getLogger } from '../../systems/handlers/logging/index';
import { getPasswordStrengthScore } from '../../../shared/utilities';

const logger = getLogger('Entrance:Register');
const EMAIL_REGEX =
	/^(?=.{1,254})(?=.{1,64}@)[a-zA-Z0-9!#$%&'*+/=?^_`{|}~.-]+@(?:(?=[a-zA-Z0-9-]{1,63}\.)(xn--)?[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*\.){1,8}(?=[a-zA-Z]{2,63})(xn--[a-zA-Z0-9]{1,59})?[a-zA-Z]{2,63}$/;
const MAX_DAILY_REGISTRATIONS_PER_IP = Number(process.env.REGISTER_IP_LIMIT || 5);

let redis;
const setRedis = r => (redis = r);

// EMAIL NORMALIZATION ----------------------------------------------------------
// Steps: normalize to a canonical address, validate format, then throw badRequest on invalid input so we fail before any existence checks.
// Rationale: keeps DB load low and prevents leaking whether an email exists via different error timing/paths.
function normalizeEmail(email) {
	if (typeof email !== 'string') throw new Error('badRequest');
	const normalized = email.trim().toLowerCase();
	if (!EMAIL_REGEX.test(normalized)) throw new Error('badRequest');
	return normalized;
}

// REGISTER RATE LIMIT ----------------------------------------------------------
// Steps: increment per-day ip bucket, set expiry on first increment, then throw when exceeding limit to cap automated abuse.
async function enforceRegisterRateLimit(ip) {
	if (!redis || !ip || !MAX_DAILY_REGISTRATIONS_PER_IP) return;
	const dayKey = new Date().toISOString().slice(0, 10),
		redisKey = `dailyIpRegisterCounts:${dayKey}`;
	const count = await redis.hincrby(redisKey, ip, 1);
	if (count === 1) await redis.expire(redisKey, 60 * 60 * 24 * 2);
	if (count > MAX_DAILY_REGISTRATIONS_PER_IP) throw new Error('registerLimited');
}

// CHECK IF EMAIL TAKEN --------------------------------------------------------
// Steps: do a narrow existence query and throw mailTaken; keeps register() sequencing readable and error codes stable.
async function checkIfMailTaken(email, con) {
	const [[userExists]] = await con.execute('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
	if (userExists) throw new Error('mailTaken');
}

// REGISTER FLOW ----------------------------------------------------------------
// Steps: normalize + validate, rate-limit, hash password, create user+login rows in a transaction, then send verification email; bounded retry handles rare id collisions.
async function register({ email, pass, ip }, con) {
	const normalizedEmail = normalizeEmail(email);
	await checkIfMailTaken(normalizedEmail, con);
	await enforceRegisterRateLimit(ip);

	// PASSWORD POLICY ---------------------------------------------------------
	// Steps: enforce strength server-side so weak clients can't bypass; fail before hashing to keep CPU bounded.
	if (typeof pass !== 'string' || Number(getPasswordStrengthScore(false, pass, undefined)) < 7) throw new Error('weakPass');

	const passCrypt = await bcrypt.hash(pass, 10);
	async function createUser(attempt = 0) {
		// CREATE USER (RETRY ON DUP) -------------------------------------------
		// Steps: generate id, insert rows in a transaction, then email; on ER_DUP_ENTRY retry a few times to avoid transient collision failure.
		if (attempt > 3) throw new Error('registrationFailed'); // Prevent infinite recursion on broken PRNG
		try {
			const userID = nanoid(7);
			await con.beginTransaction();
			await Promise.all([
				con.execute('INSERT INTO users (id, email, pass, status) VALUES (?, ?, ?, ?)', [userID, normalizedEmail, passCrypt, 'notVerified']),
				con.execute('INSERT INTO logins (user) VALUES (?)', [userID]),
			]);
			await con.commit();
			await sendEmail({
				mode: 'verifyMail',
				token: `${jwtQuickies({ mode: 'create', payload: { userID, is: 'verifyMail' }, expiresIn: '30m' })}:${Date.now() + 60 * 30 * 1000}`,
				email: normalizedEmail,
			});
			return userID; // Return userID on success for potential caller use
		} catch (error) {
			const emailDomain = normalizedEmail.includes('@') ? normalizedEmail.split('@')[1] : undefined;
			logger.error('createUser', { error, emailDomain, attempt });
			await con.rollback();
			if (error.code === 'ER_DUP_ENTRY') return createUser(attempt + 1);
			else throw new Error('registrationFailed');
		}
	}

	await createUser();
	return { payload: 'mailSent' };
}

// RESEND VERIFICATION EMAIL ---------------------------------------------------
// Steps: validate that user exists, optionally confirm password (verifyMail), then send a short-lived token for the requested mail type.
async function resendMail({ mailType, email, pass }, con) {
	const [[{ id: userID, pass: storedPass } = {}]] = await con.execute('SELECT id, pass FROM users WHERE email = ?', [email]);
	if (!storedPass) throw new Error('userNotFound');
	if (mailType === 'verifyMail' && !(await bcrypt.compare(pass, storedPass))) throw new Error('unauthorized');
	await sendEmail({
		mode: mailType,
		token: `${jwtQuickies({ mode: 'create', payload: { userID, is: mailType }, expiresIn: mailType === 'verifyMail' ? '30m' : '5m' })}:${
			Date.now() + 60 * 1000 * (mailType === 'verifyMail' ? 30 : 5)
		}`,
		email,
	});
	return { payload: 'mailResent' };
}

export { register, resendMail, checkIfMailTaken, normalizeEmail, setRedis };
