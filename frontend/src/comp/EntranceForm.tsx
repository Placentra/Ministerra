// AUTHENTICATION AND CREDENTIALS FORM ---
// Handles login, registration, password resets, and email verification workflows.
import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { forage, getDeviceFingerprint, delUndef, deriveKeyFromPassword, storePDK, clearPDK, clearPDKFromWorker } from '../../helpers';
import { emailCheck } from '../variables';
import { notifyGlobalError } from '../hooks/useErrorsMan';
import { getPasswordStrengthScore } from '../../../shared/utilities.ts';

// SOCIAL ICON ASSETS ---
const src = { Facebook: '/icons/facebook.png', Google: '/icons/google.png', Instagram: '/icons/instagram.png', Twitter: '/icons/twitter.png' };

// SYSTEM MESSAGES CONFIGURATION ---
const imgMessagesMap = {
	reencrypting: {
		header: 'Probíhá synchronizace dat',
		detail: 'Tvá lokální data jsou aktualizována. NEZAVÍREJ TUTO STRÁNKU!!! Zabere to jen pár sekund.',
		image: `/icons/surely.png`,
		noClose: true,
	},
	autoLogout: {
		header: 'Pro jistotu ...',
		detail: 'Kvůli delší nečinnosti a nebo nestandardní aktivitě jsme Tě z bezpečnostních důvodů raději odhlásili. Pro pokračování se prosím znovu přihlaš heslem.',
		image: `/icons/log out.png`,
	},
	sessionExpired: { header: 'Relace vypršela', detail: 'Otevřel jsi nový panel nebo zavřel prohlížeč. Pro pokračování se znovu přihlaš.', image: `/icons/surely.png` },
	registrationComplete: {
		header: 'Registrace dokončena!',
		detail: 'Tvůj profil byl úspěšně vytvořen. Přihlaš se prosím svým heslem.',
		image: `/icons/surely.png`,
	},
	mailSent: {
		header: 'Skvělé! Přijde ti e-mail.',
		detail: 'Do tvé schránky přijde každou chvilku email s ověřovacím odkazem, který ti otevře cestu k dalšímu kroku. Klikni na něj :-)',
		image: `/icons/email.png`,
	},
	mailNotSent: {
		header: 'Profil vytvořen, e-mail neodeslán :-(',
		detail: 'Ověřovací e-mail jsme ti kvůli technickým potížím bohužel neodeslali. Prosíme, přihlaš se do svého nového účtu později a klikni na tlačítko pro opětovné zaslání e-mailu, které zobrazí. Omlouváme se.',
		image: `/icons/error.png`,
	},
	newMailSameAsCurrent: { header: 'Emaily se shodují', detail: 'Nový email se shoduje s tím původním. Zkus to zno', image: `/icons/error.png` },
	newMailVerified: { header: 'Email změněn', detail: 'Tvůj email byl verifikován a úspěšně nastaven.', image: `/icons/surely.png` },
	userDeleted: { header: 'Profil smazán', detail: 'Tvůj profil byl úspěšně smazán.', image: `/icons/surely.png` },
	userFrozen: { header: 'Profil zmražen', detail: 'Tvůj profil byl úspěšně zmražen. Pokud se do 6 měsíců znovu nepřihlásíš, bude nenávratně deaktivován', image: `/icons/surely.png` },
	unfreezing: {
		header: 'Zahájeno odmražení profilu',
		detail: 'Než dojde k úplnému dokončení procesu reaktivace tvé profilu, bude to chvíli trvat. Obvykle né déle než 24 hodin. Přijď zpět později a možná už tě pustíme dovnitř',
		image: `/icons/surely.png`,
	},
	changeSuccess: { header: 'Změna úspěšná', detail: 'Tvůj profil byl úspěšně změněn. Nyní se přihlaš.', image: `/icons/surely.png` },
	emailReverted: {
		header: 'Email úspěšně vrácen',
		detail: 'Tvůj email k Ministerra účtu byl úspěšně nastaven na předchozí e-mailovou adresu. ⚠️ DŮRAZNĚ TI DOPORUČUJEME OKAMŽITĚ SI ZMĚNIT HESLO, pokud jsi email neměnil ty sám!',
		image: `/icons/surely.png`,
	},
	unauthorized: {
		header: 'Přístup zamítnut',
		detail: 'S největší pravděpodobností vypršela platnost tvého přihlášení, nebo nemáš oprávnění k požadované akci. Přihlaš se prosím znovu.',
		image: `/icons/error.png`,
	},
	tokenExpired: { header: 'Odkaz je neplatný', detail: 'Pravděpodobně vypršela jeho platnost a nebo si jej špatně zkopíroval (pokud si jej neotevřel kliknutím).', image: `/icons/error.png` },
	emailChangeActive: {
		header: 'Nemůžeš resetovat heslo',
		detail: 'Máš aktivní změnu emailu (platnost 7 dní). V tomto období nelze použít funkci zapomenuté heslo. Počkej nebo kontaktuj podporu.',
		image: `/icons/error.png`,
	},
	serverError: { header: 'Chyba serveru', detail: 'Něco se nepovedlo. Zkus to za 30 sekund znovu. Pokud to nepomůže, zkus to za dýl a kdyžtak nás kontaktuj', image: `/icons/error.png` },
	networkError: { header: 'Chyba sítě', detail: 'Něco se nepovedlo. Zkus to za 30 sekund znovu. Pokud to nepomůže, zkus to za dýl a kdyžtak nás kontaktuj', image: `/icons/error.png` },
	mailResent: { header: 'Odkaz znovu zaslán na mail', detail: 'Zkontroluj si schránku, snad už ti tentokrát email dorazí. Kdyžtak chvíli vydrž.', image: `/icons/email.png` },
	verifyMail: {
		header: 'Nemáš ověřený e-mail!',
		detail: 'Prosíme, klikni na verifikační odkaz, který ti přišel po registraci do schránky. Předmět e-mailu je "Verifikace e-mailu". Jdi ho najít',
		image: `/icons/error.png`,
	},
	confChange: {
		header: 'Změnu potvrď v e-mailu',
		detail: 'Z bezpečnostních důvodů je nezbytné tuto změnu finalizovat kliknutím na odkaz, který obdržíš do svého e-mailu. Po potvrzení budeš automaticky odhlášen ze všech zařízení.',
		image: `/icons/email.png`,
	},
};

// ERROR LABEL MAPPINGS ---
const submitWarnTexts = {
	nothingToChange: 'Zadej nový email nebo heslo',
	userNotFound: 'Tento email jsme nenašli',
	mailTaken: 'Tento email je již registrován',
	notAgreed: 'Souhlas je nezbytný',
	noActiveEmailChange: 'Nemáš žádnou změnu emailu k vrácení',
	newMailSameAsCurrent: 'Nový email se shoduje s aktuálním',
	emailMismatch: 'Nesouhlasí údaje o změně emailu',
	wrongPass: 'Nesprávné heslo',
	registerLimited: 'Z tohoto zařízení jsme dnes přijali příliš mnoho registrací. Zkus to prosím později.',
};

// PASSWORD STRENGTH EVALUATOR ---
// Calculates score based on length and character diversity for visual feedback.

// ENTRANCE FORM COMPONENT DEFINITION ---
// Comprehensive authentication engine handling login, registration, and credential recovery
function EntranceForm(props: any) {
	const environment = import.meta.env.VITE_NODE_ENV;

	const navigate = useNavigate(),
		{ brain, nowAt } = (props || {}) as any,
		urlParams = new URLSearchParams(window.location.search),
		returnTo = useRef(urlParams.get('returnTo') ? decodeURIComponent(urlParams.get('returnTo')) : null).current,
		isContinueMode = useRef(Boolean(returnTo && urlParams.get('mess') === 'sessionExpired')).current,
		[axiosInProg, setAxiosInProg] = useState(false),
		[showSubmitBtn, setShowSubmitBtn] = useState(false),
		[formMode, setFormMode] = useState(urlParams.get('mode') || 'login'),
		emailRef = useRef<any>(null),
		passRef = useRef<any>(null),
		repassRef = useRef<any>(null),
		passStrengthRef = useRef<any>(null),
		bSubmitRef = useRef<any>(null),
		infoMessagesRef = useRef<any>(null),
		scrollTarget = useRef<any>(null),
		refs = { emailRef, passRef, repassRef, passStrength: passStrengthRef, bSubmitRef, infoMessagesRef, scrollTarget },
		[isLogin, isRegister, isChangePass, isChangeMail, isChangeBoth, isForgotPass, isResetPass, isRevertEmail] = [
			'login',
			'register',
			'changePass',
			'changeMail',
			'changeBoth',
			'forgotPass',
			'resetPass',
			'revertEmailChange',
		].map(mode => formMode === mode),
		[data, setData] = useState({
			email: environment === 'dev' ? import.meta.env.VITE_LOGIN_MAIL || '' : '',
			pass: environment === 'dev' ? import.meta.env.VITE_LOGIN_PASS || '' : '',
			rePass: '',
			agreed: false,
			curPass: '',
		}),
		// FORM FEEDBACK STATE ---
		// Tracks validation errors and success notifications for UI feedback
		[inform, setInform] = useState<any>({
			unauthorized: false,
			capsActive: false,
			emailFormat: false,
			passFormat: false,
			passStrength: false,
			wrongPass: false,
			mailTaken: false,
			missingRepass: false,
			changeSuccess: false,
			mailSent: false,
			mailNotSent: false,
			verifyMail: false,
			passDismatch: false,
			notAgreed: false,
			userNotFound: false,
			wrongLogin: false,
			serverError: false,
			mailResent: false,
			registerLimited: false,
		}),
		showSubmitTimeout = useRef(null),
		passDismatchTimeout = useRef(null),
		emailFormatTimeout = useRef(null),
		passFormatTimeout = useRef(null),
		infoMessageShown = [
			'serverError',
			'mailSent',
			'mailNotSent',
			'confChange',
			'mailResent',
			'changeSuccess',
			'userDeleted',
			'userFrozen',
			'unfreezing',
			'verifyMail',
			'unauthorized',
			'networkError',
			'tokenExpired',
			'emailChangeActive',
			'emailReverted',
			'newMailVerified',
		].some(what => inform[what]),
		askIfResendMail = ['verifyMail', 'mailSent', 'mailResent'].some(what => inform[what]),
		isChange = ['changeMail', 'changePass', 'changeBoth'].includes(formMode),
		{ email, pass, rePass, curPass, agreed } = data,
		[capsActive, setCapsActive] = useState(false),
		showBackToLoginBtn = [
			'unauthorized',
			'changeSuccess',
			'emailReverted',
			'newMailVerified',
			'userFrozen',
			'emailChangeActive',
			'mailTaken',
			() => inform.mailSent && !isRegister,
			'mailResent',
		].some(what => (typeof what === 'function' ? what() : inform[what])),
		[mounted, setMounted] = useState(false),
		[emailValidated, setEmailValidated] = useState(false),
		emailValidationTimeout = useRef(null),
		[resendRetryCount, setResendRetryCount] = useState(0),
		[resendJustSuccess, setResendJustSuccess] = useState(false);

	// FORM MANAGER FUNCTION ---
	// Central handler for all input changes, validation, and API submissions
	async function man({ what, val, blur, submit }: any = {}) {
		console.log('🚀 ~ man ~ what:', what, { submit, blur, val });

		try {
			// INPUT CHANGE HANDLING ---
			if (!submit) {
				setInform({});
				if (blur) {
					if (what === 'email') return val && !emailCheck.test(val) && (setInform(prev => ({ ...prev, emailFormat: true })), refs.emailRef.current?.focus({ preventScroll: true }));
					// PASSWORD FORMAT BLUR VALIDATION FOR LOGIN ---
					else if (what === 'pass' && isLogin)
						return val && getPasswordStrengthScore(false, val) < 7 && (setInform(prev => ({ ...prev, passFormat: true })), refs.passRef.current?.focus({ preventScroll: true }));
					else if (what === 'rePass') return pass !== val && (setInform(prev => ({ ...prev, passDismatch: true })), refs.repassRef.current?.focus({ preventScroll: true }));
				} else {
					if (what === 'email') {
						clearTimeout(emailFormatTimeout.current);
						emailFormatTimeout.current = setTimeout(() => {
							const invalidNow = val.length > 0 && !emailCheck.test(val.toLowerCase());
							setInform(prev => ({ ...prev, emailFormat: invalidNow }));
						}, 3000);
					}
					if (what === 'pass') {
						refs.passStrength.current = (getPasswordStrengthScore as any)(false, val);
						// PASSWORD FORMAT DEBOUNCE VALIDATION FOR LOGIN ---
						if (isLogin) {
							clearTimeout(passFormatTimeout.current);
							passFormatTimeout.current = setTimeout(() => {
								const weakPassword = val.length > 0 && getPasswordStrengthScore(false, val) < 7;
								setInform(prev => ({ ...prev, passFormat: weakPassword }));
							}, 3000);
						}
					}
					if (what === 'rePass')
						clearTimeout(passDismatchTimeout.current), val && pass !== val && (passDismatchTimeout.current = setTimeout(() => setInform(prev => ({ ...prev, passDismatch: true })), 1000));
					return setData(prev => ({ ...prev, [what]: val }));
				}
			}

			// EMAIL RESEND HANDLING ---
			if (submit && what === 'resendMail') {
				if (!askIfResendMail || resendRetryCount >= 2) return;
				setAxiosInProg(true);
				setResendJustSuccess(false);
				try {
					// RESEND MAIL TYPE RESOLUTION ---
					// verifyMail: for login (unverified email) or register flows
					// resetPass: for forgot password flow
					const resolvedMailType = isLogin || isRegister ? 'verifyMail' : isForgotPass ? 'resetPass' : undefined;
					await axios.post('/entrance', delUndef({ mode: 'resendMail', mailType: resolvedMailType, email, pass }), { __skipGlobalErrorBanner: true } as any);
					setResendRetryCount(prev => prev + 1);
					setInform(prev => ({ ...prev, mailSent: false, verifyMail: false, mailResent: true }));
					setResendJustSuccess(true);
					setTimeout(() => setResendJustSuccess(false), 3000);
				} catch (err) {
					if (err.message === 'Network Error' || err.code === 'ERR_NETWORK' || !err.response) return setInform(prev => ({ ...prev, networkError: true }));
					if (err.response?.status >= 500) return setInform(prev => ({ ...prev, serverError: true }));
					const errorData = err.response?.data;
					const errorCode = typeof errorData === 'string' ? errorData : errorData?.code;
					// EXPECTED RESEND ERRORS ---
					// These have inline UI feedback; don't trigger global error banner.
					const expectedResendErrors = ['rateLimited', 'userNotFound', 'wrongPass'];
					if (errorCode) {
						setInform(prev => ({ ...prev, [errorCode]: true }));
						if (expectedResendErrors.includes(errorCode)) return;
					}
					notifyGlobalError(err, typeof errorData === 'object' ? errorData?.message : 'Nepodařilo se odeslat ověřovací e-mail.');
				} finally {
					setAxiosInProg(false);
				}
				return;
			}

			// SUBMISSION VALIDATION LOGIC ---
			const [correctEmail, strongPass] = [email && emailCheck.test(email), refs.passStrength.current === 7];
			const submitCheck = {
				register: {
					conditions: [() => correctEmail, () => strongPass, () => agreed, () => strongPass && rePass === pass],
					informs: ['emailFormat', 'passStrength', 'notAgreed', 'passDismatch'],
				},
				login: {
					conditions: [() => correctEmail, () => strongPass],
					informs: ['emailFormat', 'passStrength'],
				},
				changePassMail: {
					conditions: [
						() => !email.length && !pass.length,
						() => email.length && correctEmail,
						() => pass.length && strongPass,
						() => !rePass.length,
						() => strongPass && rePass.length && rePass === pass,
					],
					informs: ['nothingToChange', 'emailFormat', 'passStrength', 'missingRepass', 'passDismatch'],
				},
				forgotPass: { conditions: [() => correctEmail], informs: ['emailFormat'] },
				resetPass: {
					conditions: [() => strongPass, () => strongPass && rePass.length && pass === rePass],
					informs: ['passStrength', 'passDismatch'],
				},
				revertEmailChange: {
					conditions: [() => strongPass],
					informs: ['passStrength'],
				},
			};

			const { conditions, informs } = submitCheck[what] || { conditions: [], informs: [] };
			const dataValidity = conditions.map(cond => cond());
			console.log('🟡 VALIDATION CHECK:', { what, dataValidity, informs, allPassed: dataValidity.every(Boolean) });

			// FINAL SUBMISSION EXECUTION ---
			if (dataValidity.every(Boolean)) {
				setAxiosInProg(true);
				setInform({});

				// PASSWORD RESET AND EMAIL REVERT FLOWS ---
				if (isForgotPass) {
					await axios.post('/entrance', { mode: formMode, email }, { __skipGlobalErrorBanner: true } as any);
					return setResendRetryCount(0), setInform(prev => ({ ...prev, mailSent: true }));
				}
				if (isResetPass) {
					const { data: payload } = await axios.post('/entrance', { mode: formMode, newPass: pass, useAuthToken: true }, { __skipGlobalErrorBanner: true } as any);
					if (typeof payload === 'string' && Object.prototype.hasOwnProperty.call(imgMessagesMap, payload)) return setInform({ [payload]: true });
					clearPDK();
					await clearPDKFromWorker();
					return setInform({ changeSuccess: true });
				}
				if (isRevertEmail) {
					const { data: payload } = await axios.post('/entrance', { mode: formMode, pass, useAuthToken: true }, { __skipGlobalErrorBanner: true } as any);
					if (typeof payload === 'string' && Object.prototype.hasOwnProperty.call(imgMessagesMap, payload)) return setInform({ [payload]: true });
					else return setInform({ emailReverted: true });
				}

				// CREDENTIAL CHANGE FLOWS ---
				if (isChange) {
					const { data: payload } = await axios.post(
						'/entrance',
						delUndef({ mode: formMode, newEmail: formMode === 'changePass' ? undefined : email, newPass: pass, pass: curPass, useAuthToken: true }),
						{ __skipGlobalErrorBanner: true } as any
					);
					if (typeof payload === 'string' && Object.prototype.hasOwnProperty.call(imgMessagesMap, payload)) {
						if (formMode !== 'changeMail') {
							clearPDK();
							await clearPDKFromWorker();
						}
						return setInform({ [payload]: true });
					}
				}

				// CORE AUTHENTICATION FLOW (LOGIN) ---
				const print = getDeviceFingerprint();
				console.log('🟢 SENDING AXIOS REQUEST:', { mode: what, email, print });
				const rawResponse = (await axios.post('/entrance', delUndef({ mode: what, email, pass, print }), { __skipGlobalErrorBanner: true } as any))?.data;
				console.log('🟢 AXIOS RESPONSE:', rawResponse);
				const response = typeof rawResponse === 'string' ? rawResponse : rawResponse || {};

				const { status, authToken, cities, auth, authEpoch, authExpiry, previousAuth, previousEpoch, deviceID, deviceSalt, deviceKey } = typeof response === 'object' ? response : {};

				// REDIRECT TO ONBOARDING IF NEW USER ---
				if (status === 'unintroduced') return (brain.user.isUnintroduced = true), sessionStorage.setItem('authToken', authToken), navigate('/setup');
				else if (cities && auth) {
					const [userID, authHash] = auth?.split(':') || [];

					// SECURITY AND DATA STORAGE ---
					const pdk = await deriveKeyFromPassword(pass, userID + (deviceSalt || ''));
					storePDK(pdk);
					if (deviceID) localStorage.setItem('deviceID', deviceID);
					if (previousAuth) setInform(prev => ({ ...prev, reencrypting: true }));

					const authVal = authEpoch !== undefined ? { auth, print, pdk, deviceKey, epoch: authEpoch, prevAuth: previousAuth } : authHash;
					await forage({ mode: 'set', what: 'auth', val: authVal, id: userID });

					setInform(prev => ({ ...prev, reencrypting: false }));
					if (authExpiry) brain.authExpiry = authExpiry;

					Object.assign(brain.user, { ...((await forage({ mode: 'get', what: 'user' })) || {}), id: userID, cities: cities.split(',').map(Number) });

					const miscel = (await forage({ mode: 'get', what: 'miscel' })) || { initLoadData: {} };
					(miscel.initLoadData.cities = brain.user.cities), await forage({ mode: 'set', what: 'miscel', val: miscel });
					const targetUrl = returnTo || '/';
					return (brain.isAfterLoginInit = true), window.history.pushState({}, '', targetUrl), navigate(targetUrl);

					// STRING RESPONSE HANDLING ---
					// Backend sends status codes like 'mailSent', 'verifyMail', 'mailNotSent' as plain strings
				} else if (typeof response === 'string' && response.length > 0) {
					if (response === 'verifyMail') setResendRetryCount(0);
					setInform(prev => ({ ...prev, [response]: true }));
				}
			} else dataValidity.forEach((isValid, index) => !isValid && setInform(prev => ({ ...prev, [informs[index]]: true })));
		} catch (err) {
			if (err.message === 'Network Error' || err.code === 'ERR_NETWORK' || !err.response) return setInform({ networkError: true });
			if (err.response?.status >= 500) return setInform({ serverError: true });
			if (err.message === 'Request throttled') return setTimeout(() => man({ what, submit: true }), 2100);
			const errorData = err.response?.data;
			const errorCode = typeof errorData === 'string' ? errorData : errorData?.code;
			if (errorCode === 'tokenExpired') return sessionStorage.removeItem('authToken'), navigate('/entrance?mess=tokenExpired');
			// EXPECTED AUTH ERRORS ---
			// These have inline UI feedback via submitWarnTexts/imgMessagesMap; don't trigger global error banner.
			const expectedAuthErrors = [
				'wrongLogin',
				'wrongPass',
				'userNotFound',
				'mailTaken',
				'notAgreed',
				'noActiveEmailChange',
				'newMailSameAsCurrent',
				'emailMismatch',
				'registerLimited',
				'weakPass',
			];
			if (errorCode) {
				setInform({ [errorCode]: true });
				setTimeout(() => setInform(prev => ({ ...prev, [errorCode]: false })), 3000);
				// SKIP GLOBAL ERROR FOR EXPECTED CODES ---
				if (expectedAuthErrors.includes(errorCode)) return;
			}
			notifyGlobalError(err, typeof errorData === 'object' ? errorData?.message : 'Nepodařilo se zpracovat přihlášení.');
		} finally {
			setAxiosInProg(false);
		}
	}

	// VIEWPORT MANAGEMENT HOOKS ---
	// Handles scrolling and initial parameter parsing from URL
	useLayoutEffect(() => {
		if (['auth', 'mess'].some(str => urlParams.has(str))) {
			(async function () {
				const [authToken, expiry] = urlParams.get('auth')?.split(':') || [];
				if (authToken && Date.now() < Number(expiry)) {
					sessionStorage.setItem('authToken', `${authToken}:${expiry}`);
					if (urlParams.get('mode') === 'introduction') return (brain.user.isUnintroduced = true), navigate('/setup');
				} else if (authToken) setInform(prev => ({ ...prev, tokenExpired: true }));
				if (urlParams.get('mess')) setInform(prev => ({ ...prev, [urlParams.get('mess')]: true }));
				window.history.replaceState({}, '', '/entrance');
				setMounted(true);
			})();
		} else setMounted(true);
		if (refs.infoMessagesRef.current) window.scrollTo({ top: refs.infoMessagesRef.current?.getBoundingClientRect().top + window.scrollY - 400, behavior: 'smooth' });
		else refs.scrollTarget.current?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
	}, [infoMessageShown]);

	// SUBMIT BUTTON VISIBILITY LOGIC ---
	// Dynamically shows/hides submission button based on form validity
	useEffect(() => {
		clearTimeout(showSubmitTimeout.current);
		if (isResetPass) return setShowSubmitBtn(refs.passStrength.current === 7 && pass === rePass);
		if (formMode === 'register') return setShowSubmitBtn(emailCheck.test(email) && refs.passStrength.current === 7 && pass === rePass && agreed);
		if (formMode === 'login') return setShowSubmitBtn(emailCheck.test(email) && refs.passStrength.current === 7);
		if (pass.length && !refs.passStrength.current) refs.passStrength.current = getPasswordStrengthScore(false, pass);
		if (!isChange || infoMessageShown) return setShowSubmitBtn(true);
		const condition =
			(isChangeMail && emailCheck.test(email) && (isChangeMail ? getPasswordStrengthScore(false, curPass) : refs.passStrength.current) >= 7) ||
			((isChangeBoth || isChangePass) && refs.passStrength.current >= 7 && pass === rePass && curPass && getPasswordStrengthScore(false, curPass) >= 7);
		showSubmitTimeout.current = setTimeout(() => setShowSubmitBtn(condition), !condition ? 0 : 1000);
	}, [email, pass, rePass, inform, curPass]);

	// KEYBOARD INTERACTION HANDLERS ---
	// Monitors CapsLock state and Enter key submissions
	useEffect(() => {
		const handleKeyDown = e => {
			if (e instanceof KeyboardEvent) {
				if (e.key === 'Enter' && refs.bSubmitRef.current) refs.bSubmitRef.current.click();
				if (e.getModifierState('CapsLock')) setCapsActive(true);
				else if (e.key === 'CapsLock' && !e.getModifierState('CapsLock')) setCapsActive(false);
			}
		};
		const handleKeyUp = e => e instanceof KeyboardEvent && !e.getModifierState('CapsLock') && setCapsActive(false);
		document.addEventListener('keydown', handleKeyDown), document.addEventListener('keyup', handleKeyUp);
		return () => (document.removeEventListener('keydown', handleKeyDown), document.removeEventListener('keyup', handleKeyUp));
	}, [formMode]);

	// RESET STATE ON MODE SWITCH ---
	useEffect(() => {
		if (isForgotPass || isRegister) {
			setResendRetryCount(0);
			setResendJustSuccess(false);
		}
	}, [formMode]);

	// DEBOUNCED EMAIL VALIDATION HOOK ---
	useEffect(() => {
		clearTimeout(emailValidationTimeout.current);
		if (emailCheck.test(email)) {
			emailValidationTimeout.current = setTimeout(() => {
				setEmailValidated(true);
			}, 300);
		} else {
			setEmailValidated(false);
		}
		return () => clearTimeout(emailValidationTimeout.current);
	}, [email, formMode]);

	// PASSWORD FIELD AUTOFOCUS AFTER EMAIL VALIDATION ---
	useEffect(() => {
		if (!refs.emailRef.current?.length) refs.emailRef.current?.focus();
		if (emailValidated && !pass && refs.passRef.current) refs.passRef.current.focus({ preventScroll: true });
	}, [emailValidated, formMode]);

	if (!mounted) return null;
	return (
		<entrance-comp ref={refs.scrollTarget} class={`textAli boRadM marAuto h100 flexCol    justCen aliCen zinMaXl posRel   w100`}>
			{/* BACKGROUND IMAGE ------------------------------------------ */}
			<img title='Background image' className='posAbs topCen hvw80 mh60 cover  	maskLow w100' src={`${import.meta.env.VITE_FRONT_END}/headers/namestiSvobody.jpg`} />
			<inner-wrapper class={'w100 mw160 fPadHorS padBotM   block marAuto  selfCen'}>
				{/* BRANDING HEADER --- */}
				<entrance-header class='flexCol moveUpMore marBotS  aliCen textAli '>
					<img
						alt='Ministerra logo'
						className='marAuto maskLow cover bor2White bgTrans  downEvenMore posRel mw24 padHorS w40 boRadS '
						src='https://png.pngtree.com/png-clipart/20211009/original/pngtree-letter-m-logo-png-design-vector-png-image_6841484.png'
					/>
					<strong className='fs42 tShaWhiteXl zinMaXl xBold textAli miw60 inlineBlock '>Ministerra</strong>
				</entrance-header>

				{/* SESSION RESUMPTION BANNER --- */}
				{isContinueMode && !infoMessageShown && (
					<continue-mode class='marBotM block'>
						<div className='bInsetBlueDark posRel tWhite padAllM boRadS marBotS'>
							<span className='fs12 xBold block tSha10 marBotXxs'>🔐 Relace vypršela</span>
							<span className='fs11 boldXs textSha block lh1'>Zadej heslo pro pokračování na:</span>
							<span className='fs8 xBold block marTopXxs tYellow'>{returnTo}</span>
						</div>
					</continue-mode>
				)}

				{/* SOCIAL LOGINS AND MODE SWITCHER --- */}
				{!infoMessageShown && !isChange && !isResetPass && !isRevertEmail && !isContinueMode && (
					<mode-socials style={{ filter: 'saturate(0.8)' }} class={'marBotM bgTransXs padAllXxxs thickBors  boRadS w100 mw110 marAuto  block'}>
						{nowAt === 'event' && <span className='fsH shaComment borderBot  block textAli borderBot shaComment marBotS padBotS marAuto mw60 w100 boldM'>Registruj se ZDARMA!</span>}

						<social-bs class='flexCen gapXxxs bw33     shaComment    borderBot bInsetBlueTopXs  posRel    imw6'>
							{Object.keys(src).map(button => {
								return (
									<button type='button' key={button} className=' bHover hvw14 mh9 iw33 posRel bgTransXs    '>
										<img className='' src={src[button]} alt='' />
										<span className='fs8  tLightGrey lh1 '>{button}</span>
									</button>
								);
							})}
						</social-bs>
						<blue-divider class='hvw3 mh2  zin1 block  bInsetBlueTopXl  posRel   w80 marAuto' />

						<login-register class='flexCen bw50 w100 aliStretch shaBlue   marAuto'>
							{['login', 'register'].map(mode => {
								return (
									<button
										type='button'
										key={mode}
										className={`${formMode === mode ? 'bDarkBlue   borderBot arrowDown1 posRel tWhite fs14' : 'fs12'} bold hvw14 mh5    `}
										onClick={() => (setFormMode(mode), setInform({}))}>
										{mode === 'login' ? 'Přihlášení' : 'Registrace'}
										{formMode === mode && <blue-divider class={` hr0-5  block bInsetBlueTopXl borTop bgTrans  posAbs botCen w100     marAuto   `} />}
									</button>
								);
							})}
						</login-register>
					</mode-socials>
				)}

				{/* CREDENTIAL INPUT FIELDS --- */}
				{!infoMessageShown && (
					<inputs-div class={` marAuto   padHorXxl  flexCol ${isResetPass ? '' : 'gapM'} w100 mw110 `}>
						{/* WORKFLOW-SPECIFIC INSTRUCTIONS --- */}
						{(isForgotPass || isRevertEmail) && (
							<pass-reset class={`flexCol ${isResetPass ? 'marTopS' : 'marBotXs'}`}>
								<span className={`marBotXxs lh1 boldM ${isForgotPass || isRevertEmail ? 'tRed fs20 marTopXs' : 'fs22 '}`}>
									{isForgotPass ? 'Zapomenuté heslo' : isRevertEmail ? 'Vrácení emailu' : 'Nastavení nového hesla'}
								</span>
								{!isResetPass && (
									<span className='fs8 lh1'>
										{isForgotPass
											? 'Zadej e-mailovou adresu k účtu k němuž jsi nejsi jiný heslem. Pro nastavení nového hesla stačí kliknout na odkaz, který ti následně dorazí.'
											: 'Zadej heslo ke svému účtu pro potvrzení vrácení emailu na původní adresu. Pokud jsi email neměnil, ignoruj tuto stránku.'}
									</span>
								)}
								{isRevertEmail && (
									<span className='fs8 lh1 marTopS tRed xBold'>⚠️ DŮLEŽITÉ: Pokud tvůj email změnil někdo jiný, OKAMŽITĚ si změň také heslo! Tvůj účet mohl být kompromitován.</span>
								)}
							</pass-reset>
						)}

						{/* EMAIL ADDRESS INPUT --- */}
						{(isLogin || isRegister || isChangeBoth || isChangeMail || isForgotPass) && (
							<e-mail class='flexCol marTopXs'>
								<span className='fs14 xBold tDarkBlue lh1 marBotXxxs'>{`${isChangeMail || isChangeBoth ? 'nová ' : ''}e-mailová adresa`}</span>
								{inform.emailFormat && <span className='bRed tWhite xBold fs8 padVerXxxs padHorM marTopXxs  aliCen'>neplatný formát e-mailové adresy</span>}
								<input
									title='E-mailová adresa'
									ref={refs.emailRef}
									maxLength={100}
									autoFocus={true}
									className={`w100 hvh4 mih4 shaSubtleLong fs12 ${isContinueMode ? 'tGray' : ''}`}
									onChange={e => !isContinueMode && man({ what: 'email', val: e.target.value.toLowerCase() })}
									onBlur={e => !isContinueMode && man({ what: 'email', val: e.target.value.toLowerCase(), blur: true })}
									value={email}
									type='email'
									readOnly={isContinueMode}
								/>
								<blue-divider style={{ filter: 'brightness(0.5)' }} class='hr0-1  zin1 block  bInsetBlueTopXl posRel w60 opacityM marAuto' />
							</e-mail>
						)}

						{/* PASSWORD INPUT BLOCK --- */}
						{((!isForgotPass && emailValidated) || isRevertEmail) && (
							<pass-words class=' flexCol '>
								{((!isChangeMail && (isRegister || isLogin || isResetPass || isChangePass || isChangeBoth)) || isRevertEmail) && (
									<pass-word class={'flexCol '}>
										{!isResetPass && (
											<span className='fs14 xBold tDarkBlue lh1  inlineBlock marBotXxxs  xBold'>
												{isRevertEmail ? 'zadej heslo k potvrzení vrácení' : `${isChangePass || isChangeBoth ? 'zadej nové ' : ''}heslo`}
											</span>
										)}

										{inform.passStrength && <span className='tRed xBold marTopXxxs fs12  aliCen'>{pass.length > 0 ? 'Příliš slabé heslo!' : 'Prosím, vyplň heslo'} </span>}

										{/* PASSWORD FORMAT WARNING FOR LOGIN --- */}
										{isLogin && inform.passFormat && (
											<span className='bRed tWhite xBold fs8 padVerXxxs padHorM marTopXxs aliCen'>alespoň 8 znaků, velké písmeno, symbol a číslo</span>
										)}

										{!isLogin && !isRevertEmail && refs.passStrength.current < 7 && (
											<pass-instructions class=' lh1-3 marAuto marBotS posRel    flexCol '>
												<span className='fs9'>
													<strong className=' marBotXxxs tRed fs9 boldM lh1-2 marRigS '>DŮRAZNĚ doporučujeme jiné heslo,</strong>
													než jaké používáš ke svému e-mailu!
												</span>
												<span className={'fs9 '}>
													Heslo musí mít <strong className='tRed boldM'>alespoň 8 znaků, velké písmeno, symbol a číslo.</strong>
												</span>
											</pass-instructions>
										)}
										<input
											title='Heslo'
											ref={refs.passRef}
											className='w100 hvh4  shaSubtleLong fs12 phBold'
											value={pass}
											maxLength={30}
											onChange={e => man({ what: 'pass', val: e.target.value })}
											onBlur={e => isLogin && man({ what: 'pass', val: e.target.value, blur: true })}
											type='password'
										/>
										{!pass.length && <blue-divider style={{ filter: 'brightness(0.5)' }} class='hr0-1  zin1 block  bInsetBlueTopXl posRel  bgTrans w60 opacityL marAuto' />}
									</pass-word>
								)}

								{isLogin && (
									<button onClick={() => setFormMode('forgotPass')} className=' marBotS fs10 marAuto bold padAllXxs  bgTrans borBot  w40 tRed mw25 boRadXxs '>
										zapomenuté heslo
									</button>
								)}

								{/* PASSWORD STRENGTH VISUALIZER --- */}
								{(isRegister || isChangePass || isChangeBoth || isRevertEmail || isResetPass) &&
									pass.length > 0 &&
									(() => {
										const curScore = refs.passStrength.current,
											progress = (curScore / 7) * 100;
										const baseColor = curScore < 3 ? '#e53935' : curScore < 5 ? '#fb8c00' : curScore < 7 ? '#1e88e5' : '#43a047';
										const indiText = curScore < 3 ? 'Slabé' : curScore < 5 ? 'Pořád slabé' : curScore < 7 ? 'Ještě přidej' : 'Perfektní!';
										return (
											<strength-indicators class='posRel w100 marBoS zinMaXl' style={{ height: '10px' }}>
												<div
													className='posAbs w100'
													style={{
														top: '50%',
														transform: 'translateY(-50%)',
														height: '4px',
														background: `linear-gradient(90deg, transparent 0%, ${baseColor}33 ${50 - progress / 2}%, ${baseColor} 50%, ${baseColor}33 ${
															50 + progress / 2
														}%, transparent 100%)`,
														transition: 'background 0.3s ease',
													}}
												/>
												<div
													className='posAbs w100'
													style={{
														top: '50%',
														transform: 'translateY(-50%)',
														height: '1px',
														marginTop: '-3px',
														background: `linear-gradient(90deg, transparent 10%, ${baseColor}22 ${50 - progress / 2.5}%, ${baseColor}66 50%, ${baseColor}22 ${
															50 + progress / 2.5
														}%, transparent 90%)`,
														transition: 'background 0.3s ease',
													}}
												/>
												<div
													className='posAbs w100'
													style={{
														top: '50%',
														transform: 'translateY(-50%)',
														height: '1px',
														marginTop: '3px',
														background: `linear-gradient(90deg, transparent 10%, ${baseColor}22 ${50 - progress / 2.5}%, ${baseColor}66 50%, ${baseColor}22 ${
															50 + progress / 2.5
														}%, transparent 90%)`,
														transition: 'background 0.3s ease',
													}}
												/>
												<span
													className='posAbs fs9 bold tWhite'
													style={{
														left: '50%',
														top: '50%',
														transform: 'translate(-50%, -50%)',
														background: baseColor,
														padding: '4px 100px',
														borderRadius: '2px',
														whiteSpace: 'nowrap',
														boxShadow: `0 0 12px ${baseColor}88`,
														transition: 'all 0.3s ease',
													}}>
													{indiText}
												</span>
											</strength-indicators>
										);
									})()}

								{/* PASSWORD CONFIRMATION --- */}
								{(isRegister || isResetPass || isChangePass || isChangeBoth) && refs.passStrength.current === 7 && (
									<repeat-password class='flexCol marTopM  textAli '>
										<span className='fs14 lh1 tDarkBlue marBotXxs xBold'>{`zopakuj heslo`}</span>
										<input
											title='Zopakuj heslo'
											className='w100 hvh5    fs10'
											value={rePass}
											maxLength={30}
											onChange={e => man({ what: 'rePass', val: e.target.value })}
											onBlur={e => e.target.value.length > 0 && man({ what: 'rePass', val: e.target.value, blur: true })}
											type='password'
										/>
										<blue-divider
											style={{ filter: inform.passDismatch ? 'brightness(1.5)' : 'brightness(1)' }}
											class={`  zin1 block  bInsetBlueTopXl posRel  bgTrans   marAuto ${inform.passDismatch ? 'hr0-5 bRed w50' : 'hr0-2 w60'}`}
										/>
										{inform.passDismatch && (
											<span className='bRed tWhite boldXs fs8  padBotXxs mw20 posRel upLittle zinMax marAuto padHorM   aliCen'>
												{!rePass.length ? 'Zopakuj pro jistotu heslo' : 'hesla se neshodují'}
											</span>
										)}
									</repeat-password>
								)}

								{/* CURRENT PASSWORD VERIFICATION --- */}
								{isChange && (isChangeMail || (refs.passStrength.current >= 7 && pass === rePass)) && (
									<current-password class='flexCol marBotS textAli '>
										<span className='fs12 tDarkBlue lh1 marBotXxs  xBold'>aktuální heslo</span>
										<input
											className={`w100 hvh4 mih4  shaBlue borderBot fs12`}
											value={curPass}
											placeholder='min. 8 znaků, číslo, symbol a velké písmeno'
											onChange={e => man({ what: 'curPass', val: e.target.value })}
											type='password'
										/>
									</current-password>
								)}
							</pass-words>
						)}

						{/* TERMS AND CONDITIONS AGREEMENT --- */}
						{isRegister && emailValidated && rePass && pass === rePass && (
							<user-agree class='flexCen marBotS justCen gapXxs  '>
								<span className='lh1 fs7'>Přečetl jsem si</span>
								<button className='shaBlue borRed borBotLight padAllXxs'>
									<span className='fs7 xBold'> podmínky</span>
								</button>
								<label className='custom-checkbox'>
									<input type='checkbox' title='Souhlas s podmínkami' checked={agreed} onChange={() => man({ what: 'agreed', val: !agreed })} className='hidden-checkbox' />
									<span className='custom-checkbox-box'></span>
								</label>
								<button onClick={() => man({ what: 'agreed', val: !agreed })}>
									<span className='xBold fs7'>a souhlasím</span>
								</button>{' '}
								<span className='lh1 fs7'>s jejich zněním.</span>
							</user-agree>
						)}
					</inputs-div>
				)}

				{/* FEEDBACK AND ACTION MESSAGES --- */}
				{infoMessageShown &&
					(() => {
						const activeWarn = Object.keys(imgMessagesMap).find(key => inform[key] || urlParams.has(key));
						const { header, detail, image } = imgMessagesMap[activeWarn] || {};
						return (
							<info-message ref={refs.infoMessagesRef} class=' padBotXxl  posRel w100 shaBotLongDown  marAuto flexCol aliCen imw12 textAli'>
								<img src={image} alt='' className='marAuto marTopM cover w100 zin1' />
								<span className='textAli xBold marTopS marBotXs mw80 fs20  aliCen'>{header}</span>
								<span className='textAli mw80 fs9 lh1  aliCen'>{detail}</span>

								{askIfResendMail && (
									<>
										{resendRetryCount >= 2 ? (
											<span className='tRed xBold fsC posRel  marTopS lh1 inlineBlock aliCen'>Maximum pokusů (3). Zkontroluj si také složku SPAM a kdyžtak nás kontaktuj.</span>
										) : (
											<div className='flexCol aliCen marTopS gapS'>
												<button
													onClick={() => man({ what: 'resendMail', submit: true })}
													disabled={axiosInProg}
													className={`posRel padAllXs boRadXs miw35  xBold fs8  ${resendJustSuccess ? 'bDarkGreen tWhite' : 'bInsetBluetTopXs '}`}
													style={{
														cursor: axiosInProg ? 'wait' : 'pointer',
													}}
													onMouseEnter={e => {
														if (!axiosInProg && !resendJustSuccess) {
															e.target.style.transform = 'scale(1.05)';
															e.target.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
														}
													}}
													onMouseLeave={e => {
														if (!axiosInProg && !resendJustSuccess) {
															e.target.style.transform = 'scale(1)';
															e.target.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.2)';
														}
													}}>
													{resendJustSuccess ? (
														<span className='xBold fs8 tGreen'>Znovu odesláno!</span>
													) : (
														<span className='xBold fs10 tRed'>{`${
															resendRetryCount === 0 ? 'Nic mi nepřišlo' : resendRetryCount === 1 ? 'Zase nic nepřišlo.' : 'Ani do třetice ne.'
														} ${resendRetryCount < 2 ? 'Poslat znovu' : 'Zkusit naposledy'}`}</span>
													)}
												</button>
											</div>
										)}
									</>
								)}
								{formMode === 'changeBoth' && inform.mailSent && <span className='tGreen xBold fsF posRel moveDown marTopS lh1 inlineBlock aliCen'>Heslo úspěšně změněno</span>}
							</info-message>
						);
					})()}

				{/* WARNING AND ERROR NOTIFICATIONS --- */}
				{(() => {
					return Object.keys(submitWarnTexts).map(what => {
						if (inform[what]) {
							return (
								<span key={what} className='tRed xBold fsC   marVerXs lh1 inlineBlock aliCen'>
									{submitWarnTexts[what] || 'Oooops, něco se pokazilo.'}
								</span>
							);
						}
					});
				})()}

				{capsActive && <span className='tRed xBold fsC  marVerXs lh1 inlineBlock aliCen'>Caps Lock je zapnutý</span>}

				{/* PRIMARY FORM ACTION BUTTONS --- */}
				{(showSubmitBtn || showBackToLoginBtn) && (
					<action-buttons class={`flexCen w100 gapXxs  mw80 ${infoMessageShown ? 'marTopS' : ''} marAuto`}>
						{(formMode !== 'forgotPass' || !inform.mailSent) && (
							<button
								disabled={axiosInProg}
								ref={refs.bSubmitRef}
								onClick={() => {
									setInform({});
									if (infoMessageShown) return setFormMode('login'), setInform({});
									else man({ what: formMode, submit: true });
								}}
								className={` ${
									showBackToLoginBtn
										? 'bRed'
										: isChange || inform.mailSent
										? 'bInsetBlueBotXl   '
										: inform.changeSuccess || inform.emailReverted
										? 'bGreen'
										: isResetPass || isRevertEmail || inform.mailTaken || inform.verifyMail || inform.wrongPass || inform.wrongLogin
										? 'bRed'
										: 'bBlue borBot2'
								} tWhite marAuto posRel  hvw8 mh4  w50 tSha10  boRadXxs xBold fs12`}>
								{inform.changeSuccess || (inform.mailSent && !isRegister) || inform.emailReverted
									? 'Přihlásit se'
									: inform.tokenExpired || inform.verifyMail || inform.mailNotSent
									? 'Na domovskou stránku'
									: inform.unfreezing
									? 'O.K. rozumím'
									: inform.wrongPass
									? 'Nesprávné heslo'
									: inform.wrongLogin
									? 'Neplatné přihlášovací údaje'
									: isForgotPass && !inform.mailSent && !inform.mailResent
									? 'Poslat na zadaný e-mail'
									: isResetPass
									? 'Potvrdit nové heslo!'
									: isRevertEmail
									? 'Vrátit email na původní adresu'
									: ['userDeleted', 'userFrozen', 'unauthorized', 'mailResent', 'serverError', 'networkError'].some(what => inform[what]) || (inform.mailSent && isRegister)
									? 'Na domovskou stránku'
									: axiosInProg
									? isLogin
										? 'Přihlašuji ...'
										: isRegister
										? 'Vytvářím profil'
										: isRevertEmail
										? 'Vracím email...'
										: isChange
										? 'Provádím změnu'
										: ''
									: isLogin && isContinueMode
									? 'Pokračovat →'
									: isLogin
									? 'Přihlásit se'
									: isChange && !email
									? 'Aplikovat změnu'
									: isChange && email
									? 'Odeslat verifikační link'
									: isRevertEmail
									? 'Potvrdit vrácení emailu'
									: inform.mailTaken
									? 'Přepnout na přihlášení'
									: 'Pokračovat k nastavení'}
							</button>
						)}
					</action-buttons>
				)}
			</inner-wrapper>
		</entrance-comp>
	);
}

export default EntranceForm;
