import { humanizeDateTime } from '../../../helpers';
import { useState, memo, useLayoutEffect } from 'react';
import MessMenuStrip from '../menuStrips/MessMenuStrip';
import TextArea from '../TextArea';
import UserCard from '../UserCard';

// AFTER PAUSE = IS FIRST, BUT MAYBE COULD BE USED FOR DISPLAYING SOMETHING ELSE ---------------------------
function MessageStrip(props) {
	const { obj = {}, isFirst, prevDate, brain, chatObj = {}, userName, chatMan, stripMenu, setStripMenu, seenBy, getPunishmentStatus } = props,
		[modes, setModes] = useState({ share: false, profile: false, menu: false, textArea: false, protocol: false, selected: false }),
		[status, setStatus] = useState({ score: obj.score, own: obj.own, copied: false }),
		memberObj = chatObj.members?.find(user => Number(user.id) === Number(obj.user)) || (brain.users && brain.users[Number(obj.user)]) || null,
		role = obj.authorRole,
		// PUNISHMENT STATUS FOR MESSAGE AUTHOR ---------------------------
		{ punish, active, until } = getPunishmentStatus?.(memberObj) || {},
		untilMs = until ? (typeof until === 'number' ? until : new Date(until).getTime()) : null,
		punishLabel = punish === 'ban' ? 'ban' : punish === 'gag' ? 'gag' : null,
		punishUntilLabel = active && untilMs ? humanizeDateTime({ dateInMs: untilMs }) : null;

	// GLOBAL MENU TOGGLE --------------------------------------------------------
	useLayoutEffect(() => {
		if (stripMenu === obj.id) return;
		else setModes(prev => ({ ...prev, menu: false, protocol: false, profile: false, textArea: false, selected: false, preview: false }));
	}, [stripMenu, modes.menu]);

	return (
		<message-strip
			style={{ width: '100%' }}
			onClick={() => {
				if (obj.content !== null) setModes(prev => ({ ...prev, menu: !prev.menu, profile: false }));
				setStripMenu(modes.menu ? null : obj.id);
			}}
			class={`hover w100 ${modes.menu ? 'borderTop ' : ''} ${isFirst ? 'boRadXxs shaTopLight' : ''}  noBackground ${modes.protocol || modes.menu ? 'marBotS posRel' : ''} ${
				modes.textArea ? 'bor2 shaSubtleLong marBotM boRadXxs' : ''
			} flexCol posRel bInsetBlueTopXxs bHover pointer aliStart`}>
			{/* STRIP BODY -------------------------------------------------------- */}
			<strip-body class={`flexRow marAuto posRel w100`}>
				<left-side class={`flexRow justCen aliCen h100 w100 grow`}>
					{/* IMAGE + ROLE INDI---------------------------------------------------------- */}
					{isFirst && (
						<img-wrapper
							onClick={e => {
								if (modes.profile || obj.content === null) return;
								else e.stopPropagation(), setModes(prev => ({ ...prev, menu: !prev.menu, protocol: false })), setStripMenu(modes.menu ? null : obj.id);
							}}
							class={`${!obj.content ? 'mw6' : 'mw10'} w20 marRigS  flexCol justCen selfStart shaCon posRel`}>
							<img
								className={`w100 ${!obj.content ? 'mw6' : 'mw9'} miw6 aspect169 borRed shaBot boRadXxs`}
								src={memberObj?.imgVers ? `${import.meta.env.VITE_BACK_END}/public/users/${Number(obj.user)}_${memberObj.imgVers}S.webp` : '/icons/placeholdergood.png'}
								alt=''
							/>

							{/* ROLE / PUNISHMENT INDICATOR ------------------------------------------------------ */}
							{obj.content !== null && (punishLabel || (role && role !== 'member')) && (
								<span
									className={`${
										punishLabel ? 'bRed tWhite' : role === 'VIP' ? 'bPurple tWhite' : role === 'guard' ? 'bgTransXs tBlue blueGlass' : 'tGreen bgTransXs blueGlass'
									} boRadXxs posAbs botRight marTopXs padVerXxxxs padHorXxs lh1 fs8 ${punishLabel ? 'xBold' : role !== 'guard' ? 'boldM' : ''}`}>
									{punishLabel || role.slice(0, 3)}
								</span>
							)}
						</img-wrapper>
					)}

					<middle-section class={`w100 flexCol padVerXxxs  justCen h100`}>
						{/* TITLE AND AFTER TITLE ---------------------------------------------- */}
						{isFirst && obj.content !== null && (
							<title-after-title class={''}>
								<span className={`${isFirst ? 'fs9 boldS' : ''} marRigXxs wordBreak`}>{modes.menu || chatObj.type !== 'private' ? userName : userName?.split(' ')[0]}</span>
							</title-after-title>
						)}
						{/* SECOND ROW --------------------------------------------------------------- */}
						<second-row class={`flexRow ${!isFirst ? 'padLeftMessage' : ''} aliCen wrap textLeft`}>
							{/* MESSAGE CONTENT ------------------------------------------------ */}
							<span
								className={`${!isFirst ? 'fPadLeftXl' : ''} ${modes.menu || modes.textArea ? 'bold padVerXxxs fs8' : ''} ${
									obj.content === null ? 'tRed fs9 bold' : 'fs9'
								} preWrap lh1-8 marRigXs inline`}>
								{obj.content === null ? 'Zpráva byla smazána' : obj.content}
							</span>

							{/* DATE ------------------------------------------------------ */}
							{(isFirst || modes.menu) && humanizeDateTime({ dateInMs: obj.created, prevdateInMs: prevDate, getGranularPast: true }) && (
								<span className={`fs6 boldS tWhite textSha marTopXxs posAbs topRight tBlue inline marRigXs lh1`}>
									{humanizeDateTime({ dateInMs: obj.created, prevdateInMs: prevDate, getGranularPast: modes.menu ? false : true })}
								</span>
							)}
						</second-row>
					</middle-section>
				</left-side>
				{/* SEEN INDICATORS ------------------------------------------------------ */}
				{seenBy.length > 0 && !modes.menu && (
					<seen-indicators class={`flexRow justEnd gapXxxs marTopXxs posAbs botRight marRigXs`}>
						{seenBy.map(member => (
							<img
								key={member.id}
								className={`miw3 mw3  boRadXxs shaBot`}
								onError={e => (e.target.src = '/icons/placeholdergood.png')}
								src={member.imgVers ? `${import.meta.env.VITE_BACK_END}/public/users/${member.id}_${member.imgVers}S.webp` : '/icons/placeholdergood.png'}
								title={`${member.first} ${member.last}`}
							/>
						))}
					</seen-indicators>
				)}
			</strip-body>

			{/* BOTTOM PART ------------------------------------------------------------ */}
			<bottom-part onClick={e => e.stopPropagation()} class='w100'>
				{modes.textArea && <TextArea content={obj.content} attach={obj.attach} modes={modes} setModes={setModes} superMan={chatMan} thisIs={'message'} target={obj.id} />}

				{/* MENU COMPONENTS --------------------------------------------------- */}
				{modes.menu && (
					<>
						<blue-divider class={`hr0-5 borTop block bInsetBlueTopXl  bgTrans w100 marAuto`} />
						{/* PUNISHMENT INFO DISPLAY ---------------------------  */}
						{active && punishLabel && (
							<punishment-info class='flexRow justCen padVerXxs bgTransXs bInsetRed'>
								<span className='fs7 tRed xBold'>{punishLabel === 'ban' ? 'Zabanován' : 'Umlčen'}</span>
								{punishUntilLabel && <span className='fs6 tRed bold marLefXs'>– trest skončí {punishUntilLabel}</span>}
								{!until && <span className='fs6 tRed bold marLefXs'>– permanentní trest</span>}
							</punishment-info>
						)}
						<MessMenuStrip {...{ chatObj, isCardOrStrip: true, status, setStatus, modes, brain, setModes, obj, chatMan }} />
					</>
				)}
				{/* PROFILE PREVIEW ------------------------------------------------ */}
				{modes.profile && (
					<profile-wrapper class='block posRel'>
						<blurred-imgs onClick={() => setModes(prev => ({ ...prev, profile: false }))} class={`flexCen aliStretch posAbs mask h100 bInsetBlueTopXs topCen posRel w100`}>
							<div className='mih0-5 shaTop posAbs topCen opacityS shaTop zin100 bgWhite w100 aliStart' />
							<img src={`${import.meta.env.VITE_BACK_END}/public/users/${Math.floor(Math.random() * 30) + 1}_${modes.profile.imgVers}.webp`} className={`w50`} />
							<img
								src={`${import.meta.env.VITE_BACK_END}/public/users/${Math.floor(Math.random() * 30) + 1}_${modes.profile.imgVers}.webp`}
								className={`w50`}
								style={{ transform: 'scaleX(-1)' }}
							/>
						</blurred-imgs>
						<UserCard obj={modes.profile} cardsView={brain.user.cardsView.users} isProfile={true} brain={brain} setModes={setModes} showActions={true} />
					</profile-wrapper>
				)}
			</bottom-part>
		</message-strip>
	);
}

function areEqual(prev, next) {
	// INCLUDE MEMBER PUNISHMENT STATUS IN MEMO CHECK ---------------------------
	const prevMember = prev.chatObj?.members?.find(m => m.id == prev.obj?.user),
		nextMember = next.chatObj?.members?.find(m => m.id == next.obj?.user);
	return (
		prev.obj === next.obj &&
		prev.isSelected === next.isSelected &&
		prev.stripMenu === next.stripMenu &&
		prev.afterPause === next.afterPause &&
		prevMember?.punish === nextMember?.punish &&
		prevMember?.until === nextMember?.until
	);
}
export default memo(MessageStrip, areEqual);
