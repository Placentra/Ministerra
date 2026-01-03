import { useState, useRef, useEffect } from 'react';
import { getPasswordStrengthScore } from '../../../shared/utilities';
import Personals from '../comp/Personals';
import { emailCheck } from '../variables';
import { REVERT_EMAIL_DAYS } from '../../../shared/constants';

// TODO when freezing or deleting user, give user choice to cancel or delete all his events (then use the logic in Editor.js)

const attenVisibSrc = {
	ind: { title: 'Individuálně', descrip: 'Aktivuje nabídku soukromí. Každou událost můžeš nastavit zvlášt.' },
	pub: { title: 'Celá komunita', descrip: 'maximální šancE na nová přátelství, pozvání a konverzace.' },
	lin: { title: 'Spojenci + autor', descrip: 'Tvou účast uvidí jen tvoji spojenci + autor události.' },
	own: { title: 'Pouze autor', descrip: 'Tvou účast uvidí jen autor dané události a nikdo jiný.' },
};

const advaProfileActionsSrc = {
	personals: { title: 'Osobní údaje', descrip: 'Změna jména, věku a dalších osobních údajů.' },
	changeCredentials: { title: 'Email a heslo', descrip: 'Změna emailu, či hesla kterým se přihlašuješ.' },
	logoutEverywhere: { title: 'Odhlásit všude', descrip: 'Odhlásit se ze všech aktuálně přihlášených zařízení.' },
	delFreezeUser: { title: 'Zastavení účtu', descrip: 'Smazání účtu a všech jeho dat' },
};

const informings = {
	personals: [
		{ text: 'Změnu věku můžeš bez dokladu totožnosti' },
		{ redBold: ' provést pouze jednou! ' },
		{ text: 'Změna ostatních údajů je možná ' },
		{ redBold: 'jednou za 4 měsíce, přičemž prokázání totožnosti' },
		{
			text: ' požadujeme v případě podezřelých či nesmyslných údajů. Změna se projeví do několika minut u veškerého tvého obsahu. Výjimku tvoří pouze lokálně uložená data v zařízeních uživatelů = především dříve přečtené komentáře nebo profily u již proběhlých událostí, které si daný uživatel už jednou načetl. ',
			redBold: 'U těchto dat může dojít k aktualizaci až za delší dobu.',
		},
	],
	changeCredentials: [
		{ text: 'Po autorizaci heslem ihned přijde odkaz na email. ' },
		{ redBold: 'ODKAZ MÁ PLATNOST POUZE 5 MINUT!!! ' },
		{ text: 'Kliknutám na něj, budeš odkázan na stránku s protokolem ke změně. ' },
	],
	logoutEverywhere: [{ text: 'K odhlášení dojde maximálně za 20 minut. ' }, { redBold: 'Máš-li podezření na zneužití, raději si změn také heslo' }],
	delFreezeUser: [
		{ text: 'Zmražený účet zmizí z celé platformy a bude automaticky ' },
		{ redBold: 'smazán za 6 měsíců, pokud se znovu nepřihlásíš.' },
		{ text: ' Smazání účtu je nevratné a ' },
		{ redBold: 'navždy k jeho datům ztratíš přístup' },
	],
};
const imgMessagesMap = {
	mailSent: {
		header: verifyNewMail => (verifyNewMail ? 'Na nový e-mail ti přijde zpráva' : 'Skvělé! Přijde ti e-mail.'),
		detail: 'Do tvé schránky přijde každou chvilku email s autorizačním odkazem (platnost 5 minut), Klikni na něj :-)',
		image: `/icons/email.png`,
	},
	freezeUserMailSent: {
		header: 'Skvělé! Přijde ti e-mail.',
		detail: 'Do tvé schránky přijde každou chvilku email s autorizačním odkazem (platnost 5 minut). Klikni na něj pro potvrzení zmrazení účtu.',
		image: `/icons/email.png`,
	},
	deleteUserMailSent: {
		header: 'Skvělé! Přijde ti e-mail.',
		detail: 'Do tvé schránky přijde každou chvilku email s autorizačním odkazem (platnost 5 minut). Klikni na něj pro potvrzení smazání účtu.',
		image: `/icons/email.png`,
	},
	success: {
		header: 'Hotovo!!!',
		detail: 'Všechno proběhlo bez problémů.',
		image: `/icons/surely.png`,
	},
	emailChangeActive: {
		header: 'Email byl nedávno změněn!',
		detail: 'Nemůžeš změnit emailovou adresu, dokud nevyprší 7-mi denní bezpečnostní lhůta pro navrácení poslední změny. Email k tomuto účtu byl v posledním týdnu již jednou změněn.',
		image: `/icons/error.png`,
	},
	ageAlreadyChanged: {
		header: 'Věk jsi už jednou měnil!',
		detail: 'Nelze opakovaně měnit věk. O této skutečnosti jsi byl důrazně varován při předchozí změně. Pokud na změně trváš, zašli kopii svého občanského průkazu (SE STEJNÝ JMÉNEM JAKO JE NA TVÉM ÚČTU - jinak máš smolíka) na náš email. A kdyby tě náhodou napadl určitý zajímavý nápad, asi ti nemusíme připomínat, že falšování průkazů identity je tresným činem, který BUDE ŘEŠEN.',
		image: `/icons/error.png`,
	},
	personalsChangeTooRecent: {
		header: 'Osobní údaje nedávno změněny!',
		detail: 'Své osobní údaje (jméno, příjmení, věk, či pohlaví) jsi v posledních 4 měsících už měnil. Asi neni uplně v pohodě, že se ráno někdo probudí a řekne si "Dneska budu ženská/chlap o 10/30 let starší/mladší" žejo. Hoď se do klidu a nauč se žít s tím co máš a nebo - pokud se tě to týká - přestaň lhát, podvádět a manipulovat ostatní. To dělaj hajzlové. Jsi snad hajzl?',
		image: `/icons/error.png`,
	},
};

const AdvancedSetup = props => {
	const { data, loaderData, superMan, inform, setInform, passRef, changeWhat, setChangeWhat, selDelFreeze, setSelDelFreeze } = props;
	const [profileAction, setProfileAction] = useState('');
	const submitButtonTimeout = useRef(),
		emailFormatTimeout = useRef(),
		[revealSubmitButton, setRevealSubmitButton] = useState(false),
		profileActionsRef = useRef(),
		infoMessagesRef = useRef();
	const infoMessageShown = ['success', `${changeWhat}MailSent`, 'freezeUserMailSent', 'deleteUserMailSent', 'emailChangeActive', 'ageAlreadyChanged', 'personalsChangeTooRecent'].some(what =>
		inform.includes(what)
	);
	const hasAccessToCurMail = data.hasAccessToCurMail; // NO DEFAULT - user must choose ---

	// CHECK IF ANY PERSONAL DATA HAS CHANGED (for personals submit button visibility) ---
	const personalsChanged = (() => {
		if (['first', 'last', 'gender'].some(key => data[key] !== loaderData?.[key])) return true;
		const dataBirthMs = data.birth instanceof Date ? data.birth.getTime() : data.birth;
		const loaderBirthMs = loaderData?.birth instanceof Date ? loaderData.birth.getTime() : loaderData?.birth;
		return dataBirthMs !== loaderBirthMs;
	})();

	function reset() {
		setInform([]);
		setProfileAction('');
		setRevealSubmitButton(false);
		setChangeWhat(null);
		setSelDelFreeze(null);
	}

	useEffect(() => {
		const enterHandler = e => revealSubmitButton && e.key === 'Enter' && superMan(changeWhat || profileAction);
		if (passRef.current) passRef.current.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
		if (profileAction && profileActionsRef.current) profileActionsRef.current.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
		if (infoMessageShown && infoMessagesRef.current) infoMessagesRef.current.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
		window.addEventListener('keydown', enterHandler);
		return () => window.removeEventListener('keydown', enterHandler);
	}, [profileAction, passRef.current, infoMessageShown]);

	return (
		<advanced-config class='fPadHorXs block  shaStrong   posRel block  boRadL'>
			{<span className='xBold marBotXs inlineBlock marBotXl  borRed padVerXs tDarkBlue textSha fs30'>{'Pokročilé nastavení'}</span>}

			{/* INTERESTS AND PRIVACIES ------------------------------ */}
			<interests-privacy class='padTopS w100 flexCol'>
				<span className='xBold fs13  inlineBlock  marBotXxxs '>Kdo uvidí tvé účasti?</span>
				<p className='fs8  mw160 lh1-3 marAuto tDarkBlue'>Chceš aby se nabídka soukromí zobrazovala automaticky a nebo jen když budeš chtít?</p>

				{/* PRIVACIES OPTIONS -------------------------------- */}

				<privacy-choice class='flexCen w100 aliStretch  posRel    growAll '>
					{Object.entries(attenVisibSrc).map(([option, { title, descrip }]) => (
						<button
							key={option}
							className={`w25 padBotM padTopS  imw8 posRel  mw90 marAuto iw70  ${
								data.priv === option ? '  bInsetBlueTopS thickBors posRel    borTop    xBold ' : '  shaBot    tDarkBlue  hover'
							}`}
							onClick={() => superMan('priv', option)}>
							<img className='marBotXxs' src='/icons/placeholdergood.png' alt='' />
							<span className={`${data.priv === option ? 'xBold  fs15 ' : 'bold marTopAuto fs11'}  marBotXxxs `}>{title}</span>
							<span className='fs7 padHorS'>{descrip}</span>

							{/* DEFAULT VALUE FOR INDIVIDUAL PRIV ----------------------- */}
							{data.priv === 'ind' && option !== 'ind' && (
								<button
									onClick={e => {
										e.stopPropagation();
										superMan('defPriv', option);
									}}
									className={`${
										data.defPriv === option ? ' bBlue tWhite  fs7 boldM' : 'bgWhite fs7 boldM borTop tDarkBlue'
									} padHorS block downTinyBit   posAbs botCen padVerXxxs  w100 mw25    boRadXxs zinMax shaLight`}>
									výchozí
								</button>
							)}
						</button>
					))}
				</privacy-choice>

				{/* PRIVACIES MENU ACTIVATION (ON DEMAND / ALWAYS) -------------------------*/}
				{data.priv === 'ind' && (
					<ask-privacy class=' posRel  w100 mw92  padTopXs bgTransXs  marAuto boRadM marTopS bPadVerM '>
						{/* PRIVACIES PROMPT TOGGLE ---------------------------------------------------- */}
						<input
							checked={Boolean(data.askPriv)}
							onChange={e => superMan('askPriv', e.target.checked)}
							type='checkbox'
							style={{ '&:checked': { color: 'blue' } } as any}
							className='textAli  borderBot boRadXs mih3 marBotXxs mw100 marAuto w100 fs11 boldXs'
						/>
						<span className='xBold  inlineBlock fs13'>Ptát se na soukromí?</span>
						<p className='fs8  mw160 lh1-3 marAuto tDarkBlue'>Chceš aby se nabídka soukromí zobrazovala automaticky a nebo jen když budeš chtít?</p>
					</ask-privacy>
				)}
			</interests-privacy>

			{/* ADVANCED PROFILE ACTIONS -------------------------------- */}
			<profile-actions ref={profileActionsRef} class=' block  boRadL w100 marTopXxxl mw160   	 marAuto'>
				{/* SELECT ACTION BUTTONS -------------------------------- */}

				<span className='xBold marBotXxs inlineBlock fs20'>Pokročilé profilové akce</span>
				<p className='fs8  mw160 lh1-3 marAuto marBotS tDarkBlue'>Chceš aby se nabídka soukromí zobrazovala automaticky a nebo jen když budeš chtít?</p>

				<select-action class='flexCen gapXxxs zinMax aliStretch posRel   bPadVerM  w100  marAuto growAll'>
					{Object.entries(advaProfileActionsSrc).map(([action, { title, descrip }]) => (
						<button
							key={title}
							onClick={() => (
								setInform([]), superMan('pass', ''), setSelDelFreeze(null), setChangeWhat(null), setRevealSubmitButton(false), setProfileAction(profileAction === action ? '' : action)
							)}
							className={`${action === profileAction ? ' shaStrong' : 'bgTrans  tDarkBlue  hover'} posRel w25  bInsetBlueTopXs bBor2   boRadXxs mw90 marAuto`}>
							<span className={` posRel ${action === profileAction ? 'posRel tDarkBlue   xBold fs18' : '  fs13 boldXs'} `}>{title}</span>
						</button>
					))}
				</select-action>

				{profileAction && (
					<inner-wrapper class='block  marAuto w100 shaBotLongDown   mw120 padTopL padBotS  fPadHorS'>
						{/* INFO MESSAGES ---------------------------------------------------- */}
						{infoMessageShown &&
							(() => {
								const messageType =
									(changeWhat && inform.includes(`${changeWhat}MailSent`)) || inform.includes('freezeUserMailSent') || inform.includes('deleteUserMailSent')
										? (inform.includes('freezeUserMailSent') && 'freezeUserMailSent') || (inform.includes('deleteUserMailSent') && 'deleteUserMailSent') || 'mailSent'
										: Object.keys(imgMessagesMap).find(key => inform.includes(key));
								const { header, detail, image } = imgMessagesMap[messageType];

								return (
									<info-message ref={infoMessagesRef} class='  posRel w100  marAuto padVerM flexCol aliCen imw12 textAli'>
										<img src={image} alt='' />
										<span className='textAli xBold marTopS marBotXs mw100 fs17 aliCen'>
											{changeWhat === 'changeMail' && !hasAccessToCurMail && typeof header === 'function' ? header(true) : typeof header === 'function' ? header() : header}
										</span>
										<span className='textAli mw100 fs9 lh1 aliCen'>{detail}</span>
										<button onClick={() => (setInform([]), setProfileAction(''))} className='bRed padAllXs w100 mw40 tWhite fs12 xBold posRel marTopS'>
											OK, rozumím
										</button>
									</info-message>
								);
							})()}

						{/* WARNING TEXTS WRAPPER ------------------------------------- */}
						{profileAction && !infoMessageShown && (
							<inform-texts class='  block  boRadM marBotM fPadHorS   '>
								<span className='textSha marBotXxxs block xBold tRed fs16 '>UPOZORNĚNÍ!</span>
								{informings[profileAction].map(({ text, redBold }) => (
									<span key={(text || redBold).slice(0, 10)} className='fs11 mw160 lh1-3 inline marAuto'>
										{text && <span className='fs7 tDarkBlue'>{text}</span>}
										{redBold && <strong className='xBold tRed fs7'>{redBold}</strong>}
									</span>
								))}
							</inform-texts>
						)}

						{/* PERSONALS COMPONENT --------------------------------------------------- */}
						{profileAction === 'personals' && !infoMessageShown && <Personals {...props} />}

						{/* DELETE OR FREEZE ACCOUNT  -------------------------------------------------------- */}
						{profileAction === 'delFreezeUser' && !infoMessageShown && (
							<>
								<delfreeze-buttons class='flexCen marAuto gapXxs bw50 mw80 shaBotLongDown'>
									{['freezeUser', 'deleteUser'].map(action => (
										<button
											key={action}
											onClick={() => setSelDelFreeze(selAction => (selAction === action ? null : action))}
											className={`${
												action === selDelFreeze
													? action === 'freezeUser'
														? 'xBold bInsetBlueTopXs bBor2 shaStrong '
														: 'xBold bInsetBlueTopXs bBor2 shaStrong'
													: 'bgWhite shaBlueLight tDarkBlue fs10 hover'
											} marAuto w100 grow padAllXs boRadXxs borderBot  fs11   posRel`}>
											{action === 'freezeUser' ? 'zmrazit účet' : 'smazat účet'}
										</button>
									))}
								</delfreeze-buttons>
							</>
						)}

						{/* PASSWORD/EMAIL OR BOTH CHANGE ---------------------------------------------------- */}
						{profileAction === 'changeCredentials' && !infoMessageShown && (
							<change-wrapper class='flexCol  marAuto w100  shaBotLongDown  mw100  '>
								<change-what class='flexCen marAuto w100 gapXxs  '>
									{['changeMail', 'changePass', 'changeBoth'].map(action => (
										<button
											key={action}
											onClick={() => (setChangeWhat(changeWhat => (changeWhat === action ? null : action)), setInform([]))}
											className={`${
												action === changeWhat ? 'bBlue arrowDown1 xBold posRel fs12 tWhite tSha10 shaStrong' : 'bgWhite shaBlueLight tDarkBlue fs10 hover'
											} marAuto w100 grow padAllXs boRadXxs  borderBot `}>
											{action === 'changeMail' ? 'změnit e-mail' : action === 'changePass' ? 'změnit heslo' : 'obojí naráz'}
										</button>
									))}
								</change-what>
							</change-wrapper>
						)}

						{changeWhat === 'changeMail' && !infoMessageShown && (
							<change-mail class='flexCol marTopL textAli boRadM marAuto  mw80 '>
								{/* HAS ACCESS TO CURRENT EMAIL TOGGLE (no default) --- */}

								<access-bs class='flexCen mw120 marAuto marBotS w100 gapXxs'>
									{[true, false].map(b => (
										<button
											key={String(b)}
											onClick={() => superMan('hasAccessToCurMail', b)}
											className={`${
												hasAccessToCurMail === b ? 'bInsetBlueTopXs borTop tDarkBlue posRel boldM fs15' : 'bgWhite shaBlueLight tDarkBlue hover fs12'
											} marAuto w100 grow padAllS boRadXxs  `}>
											<span className=' inlineBlock marBotXxxs boldM fs12'>{b ? 'Mám přístup k emailu' : 'Nemám přístup k emailu'}</span>
											<span className='fs7'>
												{b
													? 'Ověřovací odkaz přijde na tvůj aktuální email. Po kliknutí budeš přesměrován na stránku pro potvrzení změny.'
													: `Ověřovací odkaz přijde na nový email. Na aktuální email přijde odkaz umožňující změnu vrátit do ${REVERT_EMAIL_DAYS} dnů.`}
											</span>
										</button>
									))}
								</access-bs>

								{/* NEW EMAIL INPUT (only shown after user selects access option) --- */}
								{hasAccessToCurMail !== undefined && (
									<new-mail-input class='flexCol textAli boRadM marAuto marTopS '>
										<span className='textSha  block  inlineBlock marTopXs marBotXs xBold fs12'>Zadej nový email</span>
										{inform.includes('incorrectMail') && <span className='textSha tWhite bRed padVerXxxs mw100 marAuto w100 marTopXs block bold  fs8'>Zadej platný email</span>}

										<input
											className={`textAli shaBlueLight borderBot boRadXs hvh4 mih4 marBotXxs mw100 marAuto w100 fs11 boldXs ${
												inform.includes('incorrectMail') ? 'borderRed' : ''
											}`}
											value={data.newEmail || ''}
											onChange={e => (superMan('newEmail', e.target.value), setInform(prev => prev.filter(s => s !== 'incorrectMail')))}
											onBlur={e => e.target.value && !emailCheck.test(e.target.value) && !inform.includes('incorrectMail') && setInform(prev => [...prev, 'incorrectMail'])}
											type='email'
										/>
									</new-mail-input>
								)}
							</change-mail>
						)}

						{/* CURRENT PASSWORD INPUT (for changeMail, only show after valid email entered) --- */}
						{!infoMessageShown &&
							((profileAction === 'changeCredentials' && changeWhat && (changeWhat !== 'changeMail' || emailCheck.test(data.newEmail))) ||
								selDelFreeze ||
								profileAction === 'logoutEverywhere') && (
								<current-password class='flexCol  textAli bgTransXs boRadM mw100 marTopM marAuto '>
									<span className='textSha marBotXxs block xBold  fs12'>Zadej aktuální heslo</span>
									<input
										ref={passRef}
										onChange={e => {
											clearTimeout(submitButtonTimeout.current);
											setRevealSubmitButton(getPasswordStrengthScore(false, e.target.value) >= 7);
											superMan('pass', e.target.value);
										}}
										className={`${!revealSubmitButton ? '' : ''} textAli shaBlueLight 	 boRadXs hvh4 mih4 mw120 marAuto w100 fs11 boldXs padAllS`}
										type='password'
										value={data.pass || ''}
									/>
								</current-password>
							)}

						{/* SUBMIT BUTTON FOR PASSWORD-PROTECTED ACTIONS ------------------------- */}
						{(revealSubmitButton || infoMessageShown) && profileAction !== 'personals' && (
							<button
								onClick={() => {
									if (infoMessageShown) return reset();
									// VALIDATE NEW EMAIL FOR CHANGEMAIL ACTION ---
									if (changeWhat === 'changeMail' && !emailCheck.test(data.newEmail))
										return setInform(prev => [...prev, 'incorrectMail']), setTimeout(() => setInform(prev => prev.filter(str => str !== 'incorrectMail')), 3000);
									superMan(changeWhat || profileAction);
								}}
								className={`${
									['wrongPass', 'newMailSameAsCurrent'].some(str => inform.includes(str))
										? 'bDarkRed xBold tWhite marTopS fs8 shaStrong'
										: infoMessageShown
										? 'bBlue upTiny posRel tWhite fs8 shaStrong xBold'
										: 'bDarkBlue tWhite   marAuto bor2  xBold fs8 shaStrong'
								} marAuto padHorXl downLittle posRel boRadXs fs11 padVerXs bHover w100 mw60 `}>
								{infoMessageShown
									? 'OK, rozumím'
									: inform.includes('wrongPass')
									? 'Špatné heslo!!!'
									: inform.includes('wrongLogin')
									? 'Neplatné přihlášovací údaje'
									: inform.includes('newMailSameAsCurrent')
									? 'Emaily se shodují'
									: profileAction === 'logoutEverywhere'
									? 'Odhlásit všude (zde ne)'
									: `Odeslat autorizační odkaz`}
							</button>
						)}
					</inner-wrapper>
				)}
			</profile-actions>
		</advanced-config>
	);
};

export default AdvancedSetup;
