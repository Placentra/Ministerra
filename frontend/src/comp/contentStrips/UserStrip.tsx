import { humanizeDateTime } from '../../../helpers';
import { useState, memo, useLayoutEffect } from 'react';
import ContentIndis from '../ContentIndis';
import UserMenuStrip from '../menuStrips/UserMenuStrip';
import SimpleProtocol from '../SimpleProtocol';

function UserStrip(props) {
	const {
			obj = {},
			brain,
			manageMode,
			isChatSetup,
			galleryMode,
			isSelected,
			isInvitations,
			superMan,
			chatObj = {},
			stripMenu,
			setStripMenu,
			isSearch,
			isChatMember,
			isChatRequest,
			menuView,
			rightButtons,
			chatType,
			isNewUser,
			getPunishmentStatus,
		} = props,
		[status, setStatus] = useState({ score: obj.score, blocked: obj.blocked, linked: obj.linked, trusts: obj.trusts, reported: null, unavail: obj.unavail }),
		[modes, setModes] = useState({ profile: false, menu: false, protocol: false, selected: false, invite: false }),
		{ role } = obj,
		{ punish, active, until } = getPunishmentStatus?.(obj) || {},
		// Parse until - could be Date object, timestamp, or ISO string
		untilMs = until ? (typeof until === 'number' ? until : new Date(until).getTime()) : null,
		showSecondRow = (isChatMember && role !== 'member') || isChatRequest || (['note', 'message', 'unavail', 'mess'].some(prop => obj[prop]) && (galleryMode !== 'blocks' || punish === 'block')),
		punishRemainingLabel = (() => {
			if (!punish) return null;
			if (!untilMs) return 'Trest bez omezení';
			const absolute = active && untilMs ? humanizeDateTime({ dateInMs: untilMs }) : null;
			return absolute ? `Do ${absolute}` : null;
		})(),
		// Label for punish button showing until date (for second line)
		punishUntilLabel = untilMs ? humanizeDateTime({ dateInMs: untilMs }) : null,
		roleMap = { VIP: chatType === 'VIP' ? 'VIP' : null, admin: 'admin', guard: 'hlídač', spect: 'čtenář', member: 'člen' };

	// GLOBAL MENU TOGGLE --------------------------------------------------------
	useLayoutEffect(() => {
		if (stripMenu === obj.id) return;
		else setModes(prev => ({ ...prev, menu: false, protocol: false, profile: false, textArea: false, selected: false, preview: false, roles: false }));
	}, [manageMode, stripMenu, chatType]);

	// JSX RENDER --------------------------------------------------------
	return (
		<user-strip
			style={{ width: '100%' }}
			onClick={() => {
				if (status.unavail || galleryMode === 'invitesOut' || galleryMode === 'invitesIn') return;

				if (isChatSetup || isInvitations) {
					if (brain.chatSetupData?.id && !isSearch) return;
					return superMan({ mode: 'selectUser', userObj: obj });
				} else setModes(prev => ({ ...prev, menu: !prev.menu, protocol: false, profile: false }));
				setStripMenu(modes.menu ? null : obj.id);
			}}
			class={`${
				modes.profile ? 'shaTop marBotL borderTop ' : isSelected && isSearch ? ' bInsetBlue  shaBot posRel borTop8' : isSelected ? 'boRadXxs posRel Halo' : isChatMember ? 'borderLight' : ''
			} boRadXxs  bHover ${
				modes.protocol || modes.menu ? 'marBotS borTop8 sideBors boRadXxs  posRel' : obj.flag === 'del' ? 'borderRed' : 'borBotLight'
			} flexCol posRel  bHover pointer shaComment  bBor shaBot   aliStart ${isInvitations ? '' : 'mw68'}`}>
			{/* TOP PART ------------------------------------------------------ */}
			<strip-body
				class={`${
					galleryMode === 'links' && status.linked === false ? 'borderRed boRadXs fPadHorXxxs xBold' : galleryMode === 'requests' && obj.linked === true ? 'bInsetGreen' : ''
				}   flexRow marAuto h100 w100 aliCen padVerXxxs justCen`}>
				<img-wrapper class='posRel marRigXs'>
					<img
						className={`${modes.menu ? 'bsContentGlow bDarkBlue' : ''} w18  mw10  zin100 miw7 aspect169  shaBot boRadXxs`}
						src={obj.imgVers ? `${import.meta.env.VITE_BACK_END}/public/users/${Math.floor(Math.random() * 30) + 1}_${obj.imgVers}S.webp` : '/icons/placeholdergood.png'}
						alt=''
					/>
					{!isChatSetup && !isChatMember && !isSearch && role && role !== 'member' && (
						<span
							className={`${
								role === 'VIP' ? 'bPurple ' : role === 'guard' ? 'bgTransXs  blueGlass' : 'tGreen bgTransXs blueGlass'
							} boRadXxs posAbs botRight tWhite marTopXs padVerXxxs padHorXxs lh1 ${role !== 'guard' ? 'fs8 boldM' : 'fs8'}`}>
							{role.slice(0, 3)}
						</span>
					)}
				</img-wrapper>
				<middle-section class='h100 flexCol gapXxxs justCen padTopXxs	 h100'>
					{/* TITLE AND AFTER TITLE ------------------------------------------------------ */}
					<title-aftertitle class={'textLeft'}>
						<span className={`${modes.menu || modes.profile ? 'xBold fs10' : 'bold fs10'}  marRigXxs`}>{`${obj.first} ${obj.last}`}</span>
						<span>{obj.age ? `(${obj.age} let)` : null}</span>
					</title-aftertitle>

					{/* SECOND ROW -------------------------------------------------------------- */}
					{showSecondRow && (
						<second-row class='flexRow aliCen marBotXxxs wrap textLeft'>
							{['requests', 'links', 'trusts'].includes(galleryMode) && obj.note && (
								<span className={`fs6  boRadXs   tBlue bold`}>
									<strong className='xBold tBlue textSha'>Poznámka:</strong> {obj.note}
								</span>
							)}
							{galleryMode === 'requests' && obj.message && (
								<span className={`fs6  boRadXs tGreen  bold`}>
									<strong className='xBold tGreen textSha'>Zpráva:</strong> {obj.message}
								</span>
							)}
							{/* Chat request message */}
							{isChatRequest && obj.mess && (
								<span className={`fs6 boRadXs tGreen bold w100`}>
									<strong className='xBold tGreen textSha'>Žádost:</strong> {obj.mess}
								</span>
							)}
							{obj.unavail && <span className={`fs7 xBold tRed`}>Uživatel není dostupný</span>}
						</second-row>
					)}

					{/* INDICATORS -------------------------------------------------------------- */}
					<third-row class='flexRow aliStart marBotXxxs wrap textLeft'>
						<ContentIndis
							menuView={menuView}
							status={status}
							isChats={isChatSetup || isChatMember}
							getPunishmentStatus={getPunishmentStatus}
							manageMode={manageMode}
							galleryMode={galleryMode}
							isSearch={isSearch}
							thisIs='user'
							isCardOrStrip={true}
							modes={modes}
							brain={brain}
							obj={obj}
							isNewUser={isNewUser}
						/>
						{isChatMember && punishRemainingLabel && <span className={`fs8 bGlassSubtle marLefXs tRed bold`}>{punishRemainingLabel}</span>}
					</third-row>
				</middle-section>

				{/* CHAT REQUEST ACTION BUTTONS (Accept / Refuse) ------------------------------------------------------ */}
				{isChatRequest && (
					<request-actions class='flexRow gapXxs marRigS' onClick={e => e.stopPropagation()}>
						<button onClick={() => superMan({ mode: 'approveReq', chatID: chatObj.id, targetUserID: obj.id })} className='bDarkGreen tWhite boRadXxs padHorXs padVerXxxs fs7 xBold bHover'>
							Přijmout
						</button>
						<button onClick={() => superMan({ mode: 'refuseReq', chatID: chatObj.id, targetUserID: obj.id })} className='bDarkRed tWhite boRadXxs padHorXs padVerXxxs fs7 xBold bHover'>
							Odmítnout
						</button>
					</request-actions>
				)}

				{/* CHAT MANAGE TOGGLE BUTTON (ROLE / PUNISH) ------------------------------------------------------ */}
				{!isChatRequest && (manageMode === 'roles' || ['VIP', 'group'].includes(chatType)) && !isSearch && isChatSetup && chatType !== 'private' && (
					<button
						onClick={e => {
							e.stopPropagation();
							if (manageMode === 'manage' && brain.chatSetupData?.id) superMan({ mode: 'selectUser', userObj: obj });
							else if (manageMode === 'punish') setModes(prev => ({ ...prev, protocol: prev.protocol === 'punish' ? false : 'punish' }));
							else if (!manageMode || manageMode === 'roles' || (!brain.chatSetupData?.id && ['VIP', 'group'].includes(chatType))) setModes(prev => ({ ...prev, roles: !prev.roles }));
						}}
						className={`${
							modes.roles
								? 'borRed arrowDown1 posRel  borTop8'
								: `${
										manageMode === 'punish'
											? punish
												? 'bDarkRed tWhite'
												: 'tRed xBold fs7'
											: manageMode === 'manage' && brain.chatSetupData?.id
											? 'tRed bgTrans borderLight fs8 xBold'
											: obj.role === 'VIP'
											? 'bDarkPurple tWhite '
											: obj.role === 'guard'
											? 'bDarkBlue tWhite '
											: obj.role === 'admin'
											? 'bDarkGreen tWhite '
											: obj.role === 'spect'
											? 'bRed tWhite '
											: obj.role === 'member' || (!obj.role && isChatSetup)
											? 'bBlue tWhite '
											: 'borderRight borTop2  noBackground'
								  } ${['manage', 'punish'].includes(manageMode) ? '' : obj.role === 'VIP' ? 'bRed' : obj.role === 'guard' ? 'bBlue' : obj.role === 'admin' ? 'bGreen' : ''}`
						} inlineBlock textAli vertAli fs10 boRadXxs miw6 bHover borTop shaBot  marRigS mih3  h100`}>
						{brain.chatSetupData?.id && manageMode === 'manage' ? (
							obj.flag !== 'del' ? (
								'X'
							) : (
								'vrátit'
							)
						) : manageMode === 'punish' ? (
							punish ? (
								<>
									<span className='block boldM marBotXxxs inlineBlock fs9'>{punish}</span>
									{punish !== 'kick' && <span className='block fs6'>{punishUntilLabel || '∞'}</span>}
								</>
							) : (
								'trest'
							)
						) : (
							roleMap[role] || roleMap['member']
						)}
					</button>
				)}
				{rightButtons}
			</strip-body>

			{/* BOTTOM SECTION -------------------------------------------------------------------------------- */}
			<bottom-part onClick={e => e.stopPropagation()} class='w100'>
				{/* CHAT ROLE BUTTONS ------------------------------------------- */}
				{modes.roles && (
					<>
						<blue-divider class='hr0-5 borTop block bInsetBlueTopXl borTop bgTrans w100 marAuto' />
						<role-bs class='flexRow w100 bPadXs growAll'>
							{(() => {
								const role = obj.role;
								return Object.keys(roleMap)
									.filter(key => roleMap[key])
									.map(button => (
										<button
											key={button}
											className={`fs7 bInsetBlueTop posRel bHover ${role && button === role ? 'boldM tWhite' : ''} ${
												button === 'VIP' && role === 'VIP'
													? 'bDarkPurple'
													: button === 'guard' && role === 'guard'
													? 'bDarkBlue'
													: button === 'admin' && role === 'admin'
													? 'bDarkGreen'
													: button === 'spect' && role === 'spect'
													? 'bRed'
													: button === 'member' && role === 'member'
													? 'bBlue'
													: ''
											}`}
											onClick={e => (e.stopPropagation(), superMan({ mode: 'setUserRole', id: obj.id, content: button }), setModes(prev => ({ ...prev, roles: false })))}>
											{roleMap[button]}
										</button>
									));
							})()}
						</role-bs>
					</>
				)}

				{/* MENU COMPONENTS ----------------------------------------------- */}
				{modes.menu && <blue-divider class='hr0-5 borTop block bInsetBlueTopXl borTop bgTrans w100 marAuto' />}
				{modes.menu && (
					<UserMenuStrip
						{...{
							chatObj,
							isCardOrStrip: true,
							isProfile: ['requests', 'links', 'trusts'].includes(galleryMode),
							status,
							isChatMember: isChatMember,
							setStatus,
							modes,
							brain,
							setModes,
							galleryMode,
							isSearch,
							obj,
							isChatSetup,
							manageMode,
							superMan,
						}}
					/>
				)}

				{isChatSetup && modes.protocol === 'punish' && (
					<SimpleProtocol
						setModes={setModes}
						superMan={superMan}
						obj={obj}
						target={obj.id}
						modes={modes}
						thisIs={'user'}
						brain={brain}
						setStatus={setStatus}
						chatObj={chatObj}
						chatID={chatObj?.id}
					/>
				)}
			</bottom-part>
		</user-strip>
	);
}

function areEqual(prev, next) {
	// First check if chatSetupData exists in both
	if (!prev.brain?.chatSetupData || !next.brain?.chatSetupData) {
		return false;
	}

	return (
		prev.obj === next.obj &&
		prev.isSelected === next.isSelected &&
		prev.isOpened === next.isOpened &&
		prev.stripMenu === next.stripMenu &&
		prev.manageMode === next.manageMode &&
		prev.chatType === next.chatType &&
		prev.obj.role === next.obj.role &&
		prev.obj.punish === next.obj.punish &&
		prev.obj.flag === next.obj.flag &&
		prev.brain.chatSetupData?.type === next.brain.chatSetupData?.type &&
		prev.brain.chatSetupData?.members.length === next.brain.chatSetupData?.members.length
	);
}

export default memo(UserStrip, areEqual);
