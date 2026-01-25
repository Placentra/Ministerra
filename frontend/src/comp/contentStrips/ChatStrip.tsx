import { humanizeDateTime } from '../../../helpers';
import { useState, useLayoutEffect, useRef } from 'react';
import ChatMenuStrip from '../menuStrips/ChatMenuStrip';
import ContentIndis from '../ContentIndis';

function ChatStrip(props) {
	const { obj = {}, brain, isChatsList, stripMenu, setStripMenu, isOpened, isSearch, chatMan, getPunishmentStatus, isHighlighted, curView } = props;
	const { type, id, members = [], messages = [], name, hidden, muted, imgVers, seen } = obj;
	const [status, setStatus] = useState({}),
		[modes, setModes] = useState({ menu: false, protocol: false, invite: false }),
		[highlight, setHighlight] = useState(false);
	const lastMessage = messages?.slice(-1)[0] || {};
	// Stable random ID for image path to prevent re-render flicker
	const stableRandomId = useRef((parseInt(String(id || 0).slice(-4), 36) % 30) + 1);

	// Handle highlight effect
	useLayoutEffect(() => {
		if (isHighlighted) {
			setHighlight(true);
			const timer = setTimeout(() => setHighlight(false), 3000);
			return () => clearTimeout(timer);
		}
	}, [isHighlighted]);

	// GET FUNCTION --------------------------------------------------------
	function get(mode) {
		if (mode === 'thisUser') return members.find(m => String(m.id) === String(brain.user.id));
		if (mode === 'otherUser') return members.find(m => String(m.id) !== String(brain.user.id));
		if (mode === 'lastAuthor') return lastMessage.user != null ? members.find(m => String(m.id) === String(lastMessage.user)) : null;
	}

	const meMember = get('thisUser') || {};
	const { role } = meMember;

	// GLOBAL MENU TOGGLE -------------------------------------------------
	useLayoutEffect(() => {
		stripMenu !== id && setModes(prev => ({ ...prev, menu: false, protocol: false, profile: false, textArea: false, selected: false, preview: false }));
	}, [stripMenu]);

	return (
		<chat-strip
			style={{ width: '100%' }}
			onClick={async () => {
				await chatMan({ mode: 'openChat', chatID: id });
				setModes(prev => ({ ...prev, menu: false }));
				setStripMenu(modes.menu ? null : id);
			}}
			class={`${` ${isOpened ? 'shaCon    shaTop   posRel borRed' : ''} shaComment  posRel grow w100`} ${modes.protocol || modes.menu ? 'marBotS thickBors borTop8 posRel' : ''} ${
				modes.textArea ? 'bor2 shaSubtleLong marBotM boRadXxs' : ''
			} ${highlight ? 'bsContentGlow borTop8 shaMega' : ''} flexCol posRel mw120 marAuto  bHover pointer  borBotLight aliStart`}>
			{/* STRIP BODY ---------------------------------------------------------------------- */}
			<strip-body class='flexRow   marAuto w100 aliStart'>
				{/* IMAGE WRAPPER ---------------------------------------------------------------- */}
				<img-wrapper
					onClick={e => (e.stopPropagation(), setModes(prev => ({ ...prev, menu: !prev.menu })), setStripMenu(modes.menu ? null : id))}
					class={` ${modes.menu ? 'bsContentGlow bDarkBlue boRadM' : ''} marRigXs miw7 mw12   w18 zinMax h100 shaCon posRel`}>
					<img
						className='w100  miw7  bHover marRigXs block aspect169 borRed shaBot boRadXxs'
						src={
							type === 'private' && !get('otherUser')?.imgVers
								? '/icons/placeholdergood.png'
								: type !== 'private' && !imgVers
								? '/icons/people.png'
								: `${import.meta.env.VITE_BACK_END}/public/users/${stableRandomId.current}_${(type === 'private' ? get('otherUser') : obj).imgVers}S.webp`
						}
						alt=''
					/>

					{/* ROLE BADGE ---------------------------------------------------------------- */}
					{role && !['spect', 'member'].includes(role) && (
						<span
							className={`${
								role === 'VIP' ? 'bInsetPurple tWhite tSha10' : role === 'guard' ? 'bgTransXs tBlue blueGlass' : 'tGreen tWhite bgTransXs bInsetGreen'
							} boRadXxs posAbs botLeft marTopXs  padVerXxxxs padHorXxs lh1 ${role !== 'guard' ? 'fs7 boldS ' : 'fs7'}`}>
							{role.slice(0, 3)}
						</span>
					)}
					{/* LAST AUTHOR IMAGE ---------------------------------------------------------- */}
					{(type !== 'private' && String(get('lastAuthor')?.id) !== String(brain.user.id)) || (type === 'private' && String(get('lastAuthor')?.id) !== String(brain.user.id)) ? (
						<white-wrapper class='mw3-5 boRadXs bgTransXs shaCon botRight padAllXxxs downTiny  posAbs'>
							<img
								className='aspect1610 mw3-5 boRadXxs'
								src={
									get('lastAuthor')?.imgVers
										? `${import.meta.env.VITE_BACK_END}/public/users/${get('lastAuthor').id}_${get('lastAuthor')?.imgVers}S.webp`
										: '/icons/placeholdergood.png'
								}
								alt='User'
							/>
						</white-wrapper>
					) : null}
				</img-wrapper>

				{/* MIDDLE SECTION --------------------------------------------------------------- */}
				<texts-wrapper class='h100 flexCol padTopXs padBotXxs marLefXs justCen'>
					{/* USER NAME OR GROUP CHAT TITLE + MEMBER COUNT-------------------------- */}
					<first-row class='w100 flexInline wrap'>
						<span className='fs14 boldM marRigXxs wordBreak'>
							{name || (get('otherUser')?.first || get('otherUser')?.last ? `${get('otherUser')?.first || ''} ${get('otherUser')?.last || ''}` : 'Neznámý uživatel')}
						</span>
						{hidden && !seen && <span className='fs8 xBold tRed'>Skrytý (nová zpráva)</span>}
						{muted && <img src='/icons/mute.png' className='marRigXs marHorXxs mw2' style={{ filter: 'hue-rotate(145deg) brightness(0.8) saturate(1.2)' }} alt='' />}
						<span className='fs6 tBlue bold inline marLefXs lh1'>{humanizeDateTime({ dateInMs: lastMessage.created, getGranularPast: true })}</span>
					</first-row>

					{/* CONTENT AND TIMESTAMP - FIX #5: CORRECT CONDITIONAL RENDERING ---------------------------*/}
					<second-row class='flexRow gapXxs fs9 boldM tBlue  aliCen   marTopXxs '>
						{String(brain.user.id) === String(lastMessage.user) ? (
							<span className='boldS inlineBlock'>Ty: </span>
						) : type !== 'private' && get('lastAuthor')?.first ? (
							<span className='boldS inlineBlock'>{get('lastAuthor')?.first}: </span>
						) : null}
						<span className={`${lastMessage.content === null ? 'tRed fs10 bold' : !seen ? 'xBold tGreen fs12' : 'fs8'} lh1-1  marRigXs `}>
							{lastMessage.content === null ? '>> smazaná zpráva <<' : `${lastMessage.content?.slice(0, 200)}${lastMessage.content?.length > 200 ? ' ... >>' : ''}`}
						</span>
					</second-row>

					{/* INDICATORS -------------------------------------------------------- */}
					<ContentIndis
						status={status}
						isSearch={isSearch}
						thisIs='chat'
						isChats={true}
						isCardOrStrip={true}
						modes={modes}
						brain={brain}
						obj={{ ...obj, punish: meMember.punish, who: meMember.who, until: meMember.until }}
						getPunishmentStatus={getPunishmentStatus}
					/>
				</texts-wrapper>
				{isOpened && <div className={'posAbs block h100 w8 miw1  cenLeft bInsetBlueBotXl'} />}
			</strip-body>

			{/* MENU COMPONENTS --------------------------------------------------------------------- */}
			{modes.menu && (
				<bottom-part onClick={e => e.stopPropagation()} class='w100'>
					<blue-divider class='hr0-5 borTop block bInsetBlueTopXl bgTrans w100 marAuto' />
					<ChatMenuStrip {...{ isOpened, status, isChatsList, curView, setStatus, modes, brain, chatMan, setModes, isSearch, obj, getPunishmentStatus }} />
				</bottom-part>
			)}
		</chat-strip>
	);
}

export default ChatStrip;
