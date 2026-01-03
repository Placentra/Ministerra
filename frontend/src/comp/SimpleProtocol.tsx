import { useState, useRef, useEffect, useContext } from 'react';
import axios from 'axios';
import { notifyGlobalError } from '../hooks/useErrorsMan';
import { globalContext } from '../contexts/globalContext';

export const src = {
	cz: ['Média', 'Nadávky', 'Dezinfo', 'Spam', 'jiné'],
	en: ['Link', 'Swearing', 'Dezinfo', 'Spam', 'Illegal'],
};

//TODO rename na reportData
const SimpleProtocol = props => {
	const { isMobile } = useContext(globalContext);
	const { thisIs, target, obj = {}, setModes, modes, chatID, superMan, role, nowAt, setStatus, brain, chatObj = {} } = props,
		type = modes.protocol,
		[protocol, setProtocol] = useState({ reason: [], severity: '', message: '', note: obj.note }),
		{ severity, reason, message, note } = protocol,
		scrollTarget = useRef(),
		[inform, setInform] = useState([]);

	// Get current punishment status from chatObj members
	const targetMember = chatObj?.members?.find(member => member.id === target);
	const currentPunishment = targetMember?.punish && ['ban', 'gag'].includes(targetMember.punish) ? targetMember : null;

	useEffect(() => {
		scrollTarget.current.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
	}, []);

	// MANAGER
	const man = async (inp, value = null) => {
		setInform([]);
		try {
			const newState = { ...protocol };
			const getUntil = item => {
				if (item === null) return item;
				const now = new Date();
				if (item === '15min') now.setMinutes(now.getMinutes() + 15);
				else if (item === '3hod') now.setHours(now.getHours() + 3);
				else if (item === '12hod') now.setHours(now.getHours() + 12);
				else if (item === '1den') now.setDate(now.getDate() + 1);
				else if (item === '1měsíc') now.setMonth(now.getMonth() + 1);
				// Format as local time string (YYYY-MM-DD HH:MM:SS) to preserve timezone correctly
				const pad = n => String(n).padStart(2, '0');
				return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
			};

			// CANCEL PUNISHMENT ------------------------------------------------------------
			if (inp === 'cancelPunishment') {
				const punishType = currentPunishment?.punish;
				if (punishType === 'ban') await superMan({ mode: 'unban', chatID, targetUserID: target });
				else if (punishType === 'gag') await superMan({ mode: 'ungag', chatID, targetUserID: target });
				setModes(prev => ({ ...prev, protocol: false, menu: false }));
				return;
			}

			// SUBMIT PROTOCOL --------------------------------------------------------------
			if (inp === 'submit') {
				const inform = [];
				if (type === 'report' || type === 'punish')
					inform.push(
						...(!reason.length ? ['noReason'] : []),
						...(reason.length && !reason.includes('kick') && !severity ? ['noSeverity'] : []),
						...(type === 'report' && !message.trim().length ? ['noMessage'] : [])
					);
				setInform(inform);

				// IF DATA VALID ---------------------------------------------------------
				if (inform.length === 0) {
					if (type === 'link') {
						await superMan({ mode: 'link', direct: 'out', obj, id: obj.id, note, message, brain });
					} else if (type === 'note') {
						await superMan({ mode: 'note', id: obj.id, note });
					} else if (type === 'report') {
						await axios.post('report', { mode: thisIs, target, reason: reason.join(','), severity, message });
						setStatus?.(prev => ({ ...prev, reported: true }));
					} else {
						await superMan({ mode: reason[0], until: getUntil(severity), id: chatID, chatID, targetUserID: target, content: message });
					}
					setModes(prev => ({ ...prev, protocol: false, menu: false }));
				}
			}

			if (inp !== 'reason') newState[inp] = newState[inp] === value ? '' : value;
			else
				newState.reason =
					type === 'punish'
						? newState.reason.includes(value)
							? []
							: [value]
						: newState.reason.includes(value)
						? newState.reason.filter(item => item !== value)
						: [...newState.reason, value]; // PUNISH = SINGLE SELECT ------
			setProtocol(newState);
		} catch (err) {
			notifyGlobalError(err, 'Nepodařilo se zpracovat akci.');
		}
	};

	// RENDER
	return (
		<protocol-div
			ref={scrollTarget}
			onClick={e => e.stopPropagation()}
			class={` ${nowAt === 'event' ? 'marBotM padTopL ' : ' padTopS padBotXxs '}     posRel aliCen zinMaXl  flexCol  marAuto textAli w100 `}>
			{/* CURRENT PUNISHMENT INFO -------------------------------------------------------------- */}
			{type === 'punish' && currentPunishment && (
				<current-punishment class='flexRow gapS bInsetRed padVerM lh1-5 aliCen justCen bInsetRedDark padVerXs marBotS wrap inline  fPadHorXxs borderRed  w100'>
					<span className='fs12 xBold tRed inlineBlock w100 marBotXs'>Aktuální trest</span>
					<span className='fs7 boldM marBotXxxs marRigS'>
						Typ: <span className='boldXs'>{currentPunishment.punish === 'ban' ? 'Ban' : currentPunishment.punish === 'gag' ? 'Umlčení' : currentPunishment.punish}</span>
					</span>
					{currentPunishment.until && currentPunishment.until && (
						<span className='fs7 boldM marBotXxxs marRigS'>
							Do: <span className='boldXs'>{new Date(currentPunishment.until).toLocaleString('cs-CZ')}</span>
						</span>
					)}
					{!currentPunishment.until && <span className='fs7 bol  marBotXxxs'>Trvale</span>}
					{currentPunishment.mess && (
						<span className='fs7 marBotXs boldM textAli'>
							Důvod: <span className='boldXs'>{currentPunishment.mess}</span>
						</span>
					)}
					<button className='tWhite bHover marAuto bRed marTopXs padVerXxxs padHorL boRadXs fs7 bold marTopXxs' onClick={() => man('cancelPunishment')}>
						Zrušit trest
					</button>
				</current-punishment>
			)}

			<span className={`fs18 marBotS ${type !== 'note' ? '' : 'marTopXs'}  xBold`}>{`${
				type === 'report' ? 'Nahlášení' : type === 'link' ? 'Připojení' : type === 'note' ? 'Poznámka' : 'Potrestání'
			} ${thisIs === 'user' ? 'uživatele' : thisIs === 'event' ? 'události' : thisIs === 'comment' ? 'komentáře' : thisIs === 'message' ? 'zprávy' : thisIs === 'chat' ? 'chatu' : ''} `}</span>

			{/* REPORT INSTRUCTIONS -------------------------------------------------------------- */}
			{type === 'report' && (
				<p className='fs7 textAli mw120 marBotXs'>
					Vyber prosím důvody a závažnost tvého nahlášení a prosíme, dodržuj následující: 1) Nahlašuj pouze neakceptovalné přestupky 2) Nebuď sněhová vločka, lidi jsou ..., bohužel. 3) Za
					kvalitní nahlášení získáš pozitivní body a za ně značné výhody. 4) Za negativní body či zneužití nahlašování Ti bude funkce zablokována.
				</p>
			)}

			{/* REASON BS -------------------------------------------------------------- */}
			{(type === 'report' || type === 'punish') && (
				<reason-bs class='flexRow growAll borderBot posRel  mw140 gapXxxs   w100   '>
					{(type === 'punish' ? ['kick', 'ban', 'gag'] : src.cz).map((item, idx) => {
						const reasonValue = type === 'punish' ? item : src.en[idx];
						return (
							<button
								key={item}
								className={`${reason.includes(reasonValue) ? 'bBlue borTop2 boldM tWhite' : ''} ${type === 'punish' ? 'fs8' : 'fs8'} hr5 boldM bHover`}
								onClick={() => man('reason', reasonValue)}>
								{item}
							</button>
						);
					})}
				</reason-bs>
			)}

			{/* SEVERITY BS ---------------------------------------------------------- */}
			{(type === 'report' || type === 'punish') && reason && (type === 'report' || (reason.length > 0 && reason[0] !== 'kick')) && (
				<severity-bs class='flexCen   growAll mw140  bInsetBlueTop posRel  bPadM w100 bw20 marBotM'>
					{(type === 'punish' ? ['15min', '3hod', '12hod', '1den', null] : [1, 2, 3, 4, 5]).slice(0, role === 'guard' ? 2 : undefined).map(item => (
						<button
							key={item}
							className={`${protocol.severity === item ? ' borRed boldS  bHover' : 'bgTrans shaCon'} ${type === 'report' ? 'fs7' : ' fs7'} boldXs bHover`}
							onClick={() => {
								man('severity', item);
							}}>
							{item === null ? 'Trvale' : item}
						</button>
					))}
				</severity-bs>
			)}

			{/* MESSAGE TEXTAREA ---------------------------------------------------------- */}
			{type !== 'note' && (
				<area-wrapper class=' fPadHorXxs posRel mw140 w100'>
					<span className='fs11 marBotXxs xBold  tDarkBlue   inlineBlock textAli'>{`${type !== 'report' ? 'Nepovinná zpráva' : 'Proč se ti to nelíbí?'}`}</span>
					<p className='fs8 lh1-1 marBotXs textAli mw120 '>{`${
						type === 'report'
							? 'Prosíme, vysvětli důvody tvého nahlášení, buď stručný a věcný. Čím konkrétněji popíšeš své důvody, tím spíše vyhovíme tvému nahlášení ...'
							: 'Abys v budoucnu věděl o koho se jedná. Napiš si odkud se znáte, co tě zaujalo, o čem jste mluvili, co ti slíbil'
					}`}</p>
					<textarea
						onChange={e => man('message', e.target.value)}
						maxLength={type === 'link' ? 200 : 500}
						className='growAll textAli  shaBot   textArea shaCon bBor2  mw140  fsB padAllXs w100'
						rows={4}
					/>
				</area-wrapper>
			)}

			{/* LINK-NOTE TEXTAREA ---------------------------------------------------------- */}
			{type === 'link' && (
				<link-note class='marTopS fPadHorXxs block'>
					<span className='fs11 marBotXxs xBold  tDarkBlue   inlineBlock textAli'>Nepovinná poznámka</span>
					<p className='fs8 lh1-1 textAli mw120 marBotXxs'>Abys v budoucnu věděl o koho se jedná. Napiš si odkud se znáte, co tě zaujalo, o čem jste mluvili, co ti slíbil</p>
					<area-wrapper class='padTopXxs   block   w100'>
						<textarea onChange={e => man('note', e.target.value)} maxLength={200} className='growAll textAli shaBot textArea shaCon bBor2 mw140 fsB padAllXs w100' rows={4} />
					</area-wrapper>
				</link-note>
			)}
			{type === 'note' && (
				<link-note class='flexCol aliCen w100 marAuto block'>
					<area-wrapper class='padTopXxs bInsetBlueTopS marBotS block borTop4  w100'>
						<textarea
							autoFocus={!isMobile}
							onChange={e => man('note', e.target.value)}
							value={note}
							maxLength={200}
							className='growAll textAli shaBot textArea shaCon borderBot mw140  fsB padAllXs w100'
							rows={4}
						/>
					</area-wrapper>
				</link-note>
			)}

			{/* WARNING MESSAGES ---------------------------------------------------------- */}
			{inform.length > 0 && (
				<inform-messages class='marBotXxs marTopS'>
					{(() => {
						const informTexts = {
							noReason: `Vyber ${type === 'report' ? 'důvody nahlášení' : 'způsob potrestání'}`,
							noSeverity: `Vyber ${type === 'report' ? 'závažnost prohřešku' : reason ? 'dobu potrestání' : ''}`,
							noMessage: `Napiš ${type === 'report' ? 'nám prosím' : 'prosím uživateli'} důvod${type === 'report' ? 'y nahlášení' : ' potrestání'}`,
						};
						return Object.keys(informTexts)
							.filter(key => inform.includes(key))
							.map((key, index) => (
								<span key={key} className='tRed marRigXs xBold fs9  lh1 inlineBlock aliCen'>
									{`${index > 0 ? ' + ' : ''}${informTexts[key]}`}
								</span>
							));
					})()}
				</inform-messages>
			)}

			{/* CANCEL AND SEND BUTTONS ---------------------------------------------------------- */}
			<bottom-bs class='flexCen w95 bw50 mw80    bRadXxs bPadXs'>
				<button className=' bHover posRel bInsetBlueTopXs shaBot tRed xBold fs14' onClick={() => setModes(prev => ({ ...prev, protocol: false }))}>
					Zrušit
				</button>
				<button className=' bHover posRel bInsetBlueTopXs shaBot xBold fs14 tDarkGreen' onClick={() => man('submit')}>
					{type === 'link' ? 'Odeslat' : type === 'note' ? 'Uložit' : 'Odeslat'}
				</button>
			</bottom-bs>
		</protocol-div>
	);
};

export default SimpleProtocol;
