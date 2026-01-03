import { useState, useEffect, useRef, useMemo } from 'react';
import { useOutletContext, useNavigate, useLoaderData } from 'react-router-dom';
import axios from 'axios';
import { forage, getDeviceFingerprint, areEqual, splitStrgOrJoinArr } from '../../helpers';
import BsDynamic from '../comp/BsDynamic';
import ProfileSetup from './ProfileSetup';
import AdvancedSetup from './AdvancedSetup';
import useFadeIn from '../hooks/useFadeIn';
import { notifyGlobalError } from '../hooks/useErrorsMan';
import { checkFavouriteExpertTopicsQuality } from '../../../shared/utilities';

// TODO Vyřešit co dělat při opakovanym failu uploadu
// TODO send new user to all devices through socket after saving
// TODO add question about where they heard about us
// TODO implementovat přepínání mezi vlastním profilem a tím co se nemá zobrazovat na ostatních profilech
// TODO implementovat možnost zobrazení nespojenci, kteří ale splnují určitou úroveň kvality svého účtu
// TODO need to recalculate distances inside events when user changes location
// TODO instead of sending all citiesData, send back only the cityIDs and hashID
// TODO store introAuth in Redis with TTL and check it when /location is called without userID

const sections = ['Personals', 'Cities', 'Indis', 'Basics', 'Favex', 'Picture', 'Groups'];
const allowedPayloadKeys = new Set(['first', 'last', 'birth', 'gender', 'cities', 'indis', 'basics', 'groups', 'favs', 'exps', 'shortDesc', 'priv', 'defPriv', 'askPriv', 'image']);
const commandInputs = new Set(['bigButton', 'delFreezeUser', 'changeMail', 'changePass', 'changeBoth', 'logoutEverywhere', 'hasAccessToCurMail']);

const Setup = () => {
	const { brain, nowAt, loader } = useOutletContext();
	const isIntroduction = useMemo(() => !brain.user.id, []),
		passRef = useRef(),
		[email, setEmail] = useState(''),
		[loaderData, navigate] = [useLoaderData(), useNavigate()],
		[curSection, setCurSection] = useState(() => {
			if (!isIntroduction) return sections[0];
			try {
				const stored = sessionStorage.getItem('registrationData');
				const parsed = stored ? JSON.parse(stored) : null;
				return parsed?.section || sections[0];
			} catch {
				return sections[0];
			}
		}),
		visibleSections = isIntroduction ? sections.slice(0, sections.indexOf(curSection) + 1) : sections.slice(1),
		[data, setData] = useState(() => {
			if (isIntroduction && sessionStorage.getItem('registrationData')) {
				const storedData = JSON.parse(sessionStorage.getItem('registrationData'));
				return delete storedData.section, storedData;
			} else return { ...loaderData, cities: loaderData.cities?.map(city => brain.cities.find(c => c.cityID === city) || city) || [] };
		}),
		[inform, setInform] = useState([]),
		// SAVE BUTTON STATE -------------------------------------------------------------
		// Controls the bottom "save & leave" button UI (saving/success/error) and disables clicks.
		[saveButtonState, setSaveButtonState] = useState('idle'),
		[mode, setMode] = useState('profile'),
		[selDelFreeze, setSelDelFreeze] = useState(null), // todo move to advanced, then send as val to man when submitting
		[changeWhat, setChangeWhat] = useState(''), // todo move to advanced, then send as val to man when submittin
		[fadedIn] = useFadeIn({ mode: 'setup' }),
		sessionStoreTimeout = useRef(null),
		saveButtonTimeout = useRef(null);

	// SAVE BUTTON TIMEOUT CLEANUP ----------------------------------------------------
	useEffect(() => () => saveButtonTimeout.current && clearTimeout(saveButtonTimeout.current), []);

	// STORE CURRENT STATE IN SESSION STORAGE -----------------------------------------------------------------
	useEffect(() => {
		if (!isIntroduction) return;
		if (sessionStoreTimeout.current) clearTimeout(sessionStoreTimeout.current);
		sessionStoreTimeout.current = setTimeout(() => {
			sessionStorage.setItem('registrationData', JSON.stringify({ ...data, section: curSection, image: null }));
		}, 1000);
		return () => {
			if (sessionStoreTimeout.current) {
				clearTimeout(sessionStoreTimeout.current);
				sessionStoreTimeout.current = null;
			}
		};
	}, [data, isIntroduction, curSection]);

	// SCROLL-TO-TOP AND STORE TOKEN IF PRESENT -------------------------------------------------------
	useEffect(() => {
		(async () => {
			window.scrollTo(0, 0);
			const [token, expiry] = (isIntroduction ? sessionStorage.getItem('authToken')?.split(':') : (await forage({ mode: 'get', what: 'token' }))?.split(':')) || [];
			if (!token || Date.now() > Number(expiry))
				return isIntroduction ? sessionStorage.removeItem('authToken') : await forage({ mode: 'del', what: 'token' }), navigate('/entrance?mess=unauthorized');
			else if (!isIntroduction) man();
		})();
	}, []);

	// QUALITY CHECKS FOR FAVEX TOPICS ---------------------------------------------------
	// Centralized logic shared with backend; short-word threshold is <=3.
	const checkFavexQuality = source => checkFavouriteExpertTopicsQuality({ favs: source.favs, exps: source.exps, shortWordMaxLength: 3 });
	const clearSensitiveFields = () => setData(prev => ({ ...prev, pass: '', newEmail: '' }));

	async function man(inp = null, rawVal = null) {
		// SAVE BUTTON GUARD ------------------------------------------------------------
		// Prevent double-submits while saving/success/error state is being shown.
		if (inp === 'bigButton' && saveButtonState !== 'idle') return;
		const value = inp === 'newEmail' && typeof rawVal === 'string' ? rawVal.trim().toLowerCase() : rawVal;
		const shouldUpdateData = typeof inp !== 'undefined' && !commandInputs.has(inp);
		const defPrivPatch = !isIntroduction && shouldUpdateData && ['priv', 'defPriv'].includes(inp) ? { defPriv: inp === 'priv' ? (value === 'ind' ? 'pub' : data.defPriv || 'pub') : value } : {};
		const newData = shouldUpdateData ? { ...data, [inp]: value, ...defPrivPatch } : data;

		const collectIssues = targetData => {
			const issues = [];
			const reqConditions = {
				Cities: () => {
					if (!targetData.cities?.length) issues.push('noCity');
				},
				Personals: () => {
					['first', 'last'].forEach(field => {
						const fieldVal = targetData[field];
						if (!fieldVal) return issues.push(field === 'first' ? 'noFirstName' : 'noLastName');
						if (fieldVal.length < 2) issues.push(field === 'first' ? 'shortFirstName' : 'shortLastName');
					});
					if (!targetData.birth) issues.push('noBirthDate');
					else {
						const birthDate = new Date(targetData.birth);
						const age = Math.floor((Date.now() - birthDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
						if (age < 13) issues.push('tooYoung');
					}
					if (!targetData.gender) issues.push('noGender');
				},
				Basics: () => {
					if (!targetData.basics?.length || targetData.basics.length < 3) issues.push('addBasics');
				},
				Favex: () => {
					if (!targetData.favs?.length || targetData.favs.length < 2) issues.push('addFavs');
				},
			};
			visibleSections.filter(section => Object.keys(reqConditions).includes(section)).forEach(section => reqConditions[section] && reqConditions[section]());
			checkFavexQuality(targetData).forEach(issue => {
				if (!issues.includes(issue)) issues.push(issue);
			});
			return issues;
		};

		try {
			setInform([]);
			if (inp === 'delFreezeUser') {
				if (!selDelFreeze) return setInform(prev => [...prev, 'somethingsWrong']);
				await axios.post('/entrance', { mode: selDelFreeze, pass: data.pass });
				clearSensitiveFields();
				setSelDelFreeze(null);
				return setInform(prev => [...prev, `${selDelFreeze}MailSent`]);
			}

			if (inp === 'hasAccessToCurMail') {
				return setData(prev => ({ ...prev, hasAccessToCurMail: value, ...(value ? { newEmail: '' } : {}) }));
			}

			if (['changeMail', 'changePass', 'changeBoth'].includes(inp)) {
				await axios.post('/entrance', { mode: inp, pass: data.pass, newEmail: data.newEmail, ...(inp === 'changeMail' && { hasAccessToCurMail: data.hasAccessToCurMail ?? true }) });
				sessionStorage.removeItem('authToken'), clearSensitiveFields();
				return setInform(prev => [...prev, `${inp}MailSent`]);
			}

			if (inp === 'logoutEverywhere') {
				await axios.post('/entrance', { mode: inp, pass: data.pass });
				clearSensitiveFields();
				return setInform(prev => [...prev, 'success']);
			}

			if (inp !== 'bigButton') {
				shouldUpdateData && setData(newData);
				if (!isIntroduction) {
					const issues = collectIssues(newData);
					issues.length ? setInform(issues) : setInform([]);
				}
				return;
			}

			const issues = collectIssues(newData);
			if (issues.length) return setInform(issues);
			if (isIntroduction && curSection !== sections[sections.length - 1]) return setCurSection(sections[sections.indexOf(curSection) + 1]);

			setSaveButtonState('saving');
			setInform(['finalizing']);
			const prep = val => {
				if (val instanceof Date) return val.toISOString().split('T')[0];
				if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(val)) return val.split('T')[0];
				return Array.isArray(val) ? val.sort() : val;
			};
			const payload = Object.fromEntries(
				Object.entries(data)
					.filter(([key]) => allowedPayloadKeys.has(key))
					.map(([key, val]) => [key, key === 'image' ? val : prep(val)])
					.filter(([key, val]) => !['locaMode', 'age'].includes(key) && !(!val && !loaderData[key]) && !areEqual(val, loaderData[key]))
			);

			splitStrgOrJoinArr(payload, 'join'), delete payload.age, delete payload.imgVers;
			if (payload.cities?.length) {
				const payloadCityIds = payload.cities.map(city => city.cityID || city).sort();
				if (areEqual(payloadCityIds, (loaderData.cities || []).slice().sort())) delete payload.cities;
				else payload.cities = payload.cities.map(city => (city.cityID ? city.cityID : city));
			}
			if (!Object.keys(payload).length) return brain.fastLoaded ? navigate('/') : navigate(-1);

			const { citiesData, auth, imgVers } = (await axios.post('/setup', Object.assign(payload, !brain.user.id && { print: getDeviceFingerprint(), useAuthToken: true }))).data;
			const miscel = (await forage({ mode: 'get', what: 'miscel' })) || {};
			if (imgVers) payload.imgVers = imgVers;

			if (payload.cities) {
				if (citiesData) citiesData.forEach(city => brain.cities.push({ ...city, cityID: Number(city.cityID) }));
				payload.cities = payload.cities.map(city => (typeof city === 'object' ? Number(brain.cities.find(c => c.hashID === city.hashID).cityID) : city));
				(miscel.initLoadData = { ...(miscel.initLoadData || {}), cities: payload.cities }), await forage({ mode: 'set', what: 'miscel', val: miscel });
			}

			// SET DATA TO BRAIN AND FORAGE -----------------------------------------------------
			if (isIntroduction) {
				const [userID, hash] = auth.split(':');
				await forage({ mode: 'set', what: 'auth', val: hash, id: userID });
				(brain.user.id = userID), (brain.user.cities = brain.user.curCities = payload.cities);
			}

			(payload.age = data.age), delete payload.birth, delete payload.image;
			sessionStorage.removeItem('registrationData'), sessionStorage.removeItem('authToken'), delete brain.user.isUnintroduced;
			Object.assign(brain.user, splitStrgOrJoinArr(payload, 'split')), await forage({ mode: 'set', what: 'user', val: brain.user });

			// SUCCESS UI + DELAYED NAVIGATION ------------------------------------------------
			// Show success state in the button, disable it, and navigate away after 2 seconds.
			setSaveButtonState('success');
			saveButtonTimeout.current && clearTimeout(saveButtonTimeout.current);
			saveButtonTimeout.current = setTimeout(() => (isIntroduction || brain.fastLoaded ? (window.history.replaceState({}, '', '/'), loader.load('/')) : navigate(-1)), 2000);
		} catch (err) {
			const errorData = err.response?.data;
			const errorCode = typeof errorData === 'string' ? errorData : errorData?.code;
			if (['newMailSameAsCurrent', 'wrongPass', 'emailChangeActive', 'ageAlreadyChanged', 'personalsChangeTooRecent'].includes(errorCode)) return setInform(prev => [...prev, errorCode]);
			const authErrorCode = errorCode || err.message;
			if (['unauthorized', 'tokenExpired', 'logout'].includes(authErrorCode))
				return await forage({ mode: 'del', what: 'token' }), sessionStorage.removeItem('authToken'), navigate(`/entrance?mess=${authErrorCode}`);
			setInform([]);
			// ERROR UI (NO NAVIGATION) -------------------------------------------------------
			// Show error state in the button briefly, disable it while visible.
			setSaveButtonState('error');
			saveButtonTimeout.current && clearTimeout(saveButtonTimeout.current);
			saveButtonTimeout.current = setTimeout(() => setSaveButtonState('idle'), 2000);
			notifyGlobalError(err, typeof errorData === 'object' ? errorData?.message : 'Nepodařilo se uložit změny nastavení.');
		}
	}

	// RENDER SETUP COMPONENT ----------------------------------------------
	return (
		<setup-comp class='mihvh100 block  posRel   textAli w100 '>
			{/* MAIN SETUP CATEGORIES BUTTONS ------------------------------------------------- */}
			{!isIntroduction && (
				<cat-bs class={` flexCen marAuto posRel bInsetBlue thickBors  padTopXl  w100`}>
					{['profile', 'advanced'].map(m => (
						<button
							key={m}
							onClick={() =>
								!inform.length ? setMode(m) : (setInform(prev => ['somethingsWrong', ...prev]), setTimeout(() => setInform(prev => prev.filter(w => w !== 'somethingsWrong')), 2000))
							}
							className={` ${mode === m ? 'bBlue boRadXs borBot8 arrowDown posRel tWhite xBold ' : ' bgTransXxs  bGlassSubtle'} textSha fs12  mw60  bHover grow tSha10 hvw2 mih4`}>
							{m === 'profile' ? 'Základní' : m === 'advanced' ? 'Pokročilé' : m === 'blocks' ? 'Bloknutí' : 'Platforma'}
						</button>
					))}
					{inform.includes('somethingsWrong') && (
						<span className='bDarkRed  shaBot tSha10 textAli inlineBlock pointer marAuto posAbs botCen moveDown zinMax  selfEnd tWhite padAllXs w100 mw80 boRadS xBold fs7'>
							Nedříve oprav chyby v této sekci
						</span>
					)}
				</cat-bs>
			)}
			<blue-divider class='hr5  zin1 block bInsetBlueTopXl borTop bgTrans w100 mw120 marAuto posRel' />
			<sections-wrapper class={'block fPadHorXxs'}>
				{/* PROFILE SETUP CATEGORY WRAPPER  -----------------------------------------------*/}
				{(isIntroduction || mode === 'profile') && <ProfileSetup {...{ inform, setInform, isIntroduction, superMan: man, brain, nowAt, fadedIn, visibleSections, curSection, data }} />}
				{/* ADVANCED SETUP SECTION ------------------------------------------------------ */}
				{mode === 'advanced' && (
					<AdvancedSetup {...{ data, loaderData, superMan: man, brain, nowAt, inform, setInform, passRef, email, setEmail, changeWhat, setChangeWhat, selDelFreeze, setSelDelFreeze }} />
				)}

				{/* BIG BUTTON FOR sSAVING OR MOVING TO NEXT SECTION ----------------------------- */}
				{!isIntroduction && (
					<BsDynamic
						nowAt={nowAt}
						superMan={man}
						disabled={saveButtonState !== 'idle'}
						text={
							saveButtonState === 'saving'
								? 'Ukládám změny...'
								: saveButtonState === 'success'
								? 'Uloženo'
								: saveButtonState === 'error'
								? 'Uložení selhalo'
								: inform.length > 0 && mode === 'profile'
								? 'Oprav chyby v této sekci'
								: 'Uložit změny a odejít'
						}
						className={` posFix botCen ${saveButtonState === 'error' ? 'bRed' : 'bDarkGreen'}`}
					/>
				)}

				{!isIntroduction && <empty-div class='block hvh10 mih16'></empty-div>}
			</sections-wrapper>
		</setup-comp>
	);
};

export default Setup;
