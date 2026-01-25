import { memo, useState, useEffect } from 'react';
import ContentIndis from '../ContentIndis';
import { humanizeDateTime } from '../../../helpers';
import AlertMenuStrip from '../menuStrips/AlertMenuStrip';

/** ----------------------------------------------------------------------------
 * ALERT STRIP COMPONENT
 * Renders a single alert notification item with icon, text, and optional actions.
 * Manages its own menu/options state and displays context-aware content.
 * -------------------------------------------------------------------------- */
function AlertStrip(props) {
	// PROPS & STATE -----------------------------------------------------------
	const { alert, brain, menuView, setMenuView, onRemoveAlert, storeAlertsData, isToast = false, onClick: onToastClick, stripMenu, setStripMenu } = props;
	const { what, data = {}, created, flag = 'ok', refused, accepted, linked, inter, interPriv } = alert || {};
	const isMessageToast = isToast && (what === 'message' || what === 'newChat');
	const [modes, setModes] = useState({ menu: stripMenu === alert?.id, inter: false, privs: false, evePreview: false, profile: false });

	const initialStatus = {
		refused: refused === true ? true : flag === 'ref' ? true : null,
		accepted: accepted === true ? true : flag === 'acc' ? true : null,
		linked: linked || false,
		inter: inter || null,
		interPriv: interPriv || null,
	};
	const [status, setStatus] = useState(initialStatus);

	// EFFECTS -----------------------------------------------------------------

	// RESTORE MENU FROM BACK NAVIGATION ---
	useEffect(() => {
		if (stripMenu === alert?.id && !modes.menu) setModes(prev => ({ ...prev, menu: true }));
		else if (stripMenu !== alert?.id && modes.menu) setModes(prev => ({ ...prev, menu: null }));
	}, [stripMenu]);

	// CLOSE MENU ON VIEW CHANGE ---
	useEffect(() => {
		if (!modes.menu) return;
		else if (menuView !== 'gallery' && menuView !== 'alerts') setModes(prev => ({ ...prev, menu: null }));
	}, [menuView]);

	// CONTENT FORMATTING ------------------------------------------------------
	const parseCreatedMs = val => {
		if (!val) return null;
		if (typeof val === 'number') return val;
		const s = String(val);
		return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? Date.parse(s + 'Z') : Date.parse(s);
	};
	const createdMs = parseCreatedMs(created);
	const createdText = createdMs ? humanizeDateTime({ dateInMs: createdMs }) : '';
	const fullName = `${(data.first || '') + (data.last ? ' ' + data.last : '')}`.trim();
	const inviteDir = data?.dir || 'in';
	const inviteFlagComputed = status.refused === true ? 'ref' : status.accepted ? 'acc' : flag || data?.flag || null;
	const inviteEventTitle = data?.title || '';
	const inviteActionTextMap = { acc: 'přijal pozvání na', ref: 'odmítnul pozvání na', del: 'zrušil pozvání na' };
	const inviteActionText = inviteActionTextMap[inviteFlagComputed] || 'odpověděl na pozvání na';
	const isOutgoingInvite = what === 'invite' && inviteDir === 'out';
	const outgoingInviteTitle = `${(fullName || 'Někdo').trim() || 'Někdo'} ${inviteActionText} ${inviteEventTitle || 'událost'}`;

	let subtitle = '';
	if (what === 'interest') {
		const c = { sur: data?.sur, may: data?.may, int: data?.int };
		const parts = [];
		if (c.sur) parts.push(`${c.sur >= 0 ? '+' : ''}${c.sur} určitě`);
		if (c.may) parts.push(`${c.may >= 0 ? '+' : ''}${c.may} možná`);
		if (c.int) parts.push(`${c.int >= 0 ? '+' : ''}${c.int} sledují`);
		subtitle = parts.join('  ');
	} else if (what === 'eve_rating') subtitle = typeof data?.points === 'number' ? `Získala ${data.points >= 0 ? '+' : ''}${data.points} nových bodů!` : data?.title || '';
	else if (what === 'user_rating') subtitle = typeof data?.points === 'number' || typeof data?.counts === 'number' ? `Získal${fullName ? 'a' : ''} ${(data.points ?? data.counts) >= 0 ? '+' : ''}${data.points ?? data.counts} nových bodů!` : '';
	else if (what === 'comm_rating') subtitle = data?.content || '';
	else if (what === 'invite') subtitle = isOutgoingInvite ? (inviteFlagComputed === 'acc' ? 'Pozvánka přijata' : inviteFlagComputed === 'ref' ? 'Pozvánka odmítnuta' : inviteFlagComputed === 'del' ? 'Pozvánka zrušena' : '') : (data?.note || '').trim() || data?.title || '';
	else if (what === 'link') subtitle = data?.message || '';
	else if (what === 'message' || what === 'newChat') subtitle = data?.content ? (data.content.length > 80 ? data.content.slice(0, 80) + '...' : data.content) : data?.attach ? '📎 Příloha' : '';
	else subtitle = data?.content || '';

	const subtitleNode = subtitle ? <span className={'fs8 marRigS tDarkBlue boldS'}>{subtitle}</span> : null;
	const originalNode = what === 'reply' && data?.original ? <span className={'fs8 tGrey marLefXs'}>{subtitle ? `· v odpovědi na: „${data.original}”` : `v odpovědi na: „${data.original}”`}</span> : null;

	// THUMBNAIL LOGIC ---
	const useUserThumb = new Set(['invite', 'link', 'accept', 'comm_rating', 'comment', 'reply', 'user_rating', 'message', 'newChat']).has(what);
	let thumbUrl = '/icons/placeholdergood.png';
	const userIdForThumb = what === 'message' || what === 'newChat' ? data?.user?.id : data?.user || (useUserThumb ? alert?.target : undefined);
	const userVimg = what === 'message' || what === 'newChat' ? data?.user?.imgVers : data?.imgVers;
	if (useUserThumb && userVimg && userIdForThumb) thumbUrl = `${import.meta.env.VITE_BACK_END}/public/users/${userIdForThumb}_${userVimg}S.webp`;
	else if ((what === 'interest' || what === 'eve_rating') && (data?.event || alert?.target)) {
		thumbUrl = `${import.meta.env.VITE_BACK_END}/public/events/${Math.floor(Math.random() * 30)}_1S.webp`;
	}

	// TYPE & TARGET ---
	const messageAuthor = data?.user ? `${data.user.first || ''} ${data.user.last || ''}`.trim() : '';
	const messageChatName = data?.chatName || messageAuthor || 'Nová zpráva';
	const chatTypeLabel = { private: 'soukromý', group: 'skupinový', free: 'volný' };
	const newChatTypeText = data?.chatType ? chatTypeLabel[data.chatType] || data.chatType : '';
	const newChatNameText = data?.chatName && data?.chatType !== 'private' ? ` "${data.chatName}"` : '';

	let typeNode = null,
		targetNode = null;
	if (what === 'message') {
		typeNode = 'nová zpráva';
		targetNode = <span className="tGreen boldM">{messageChatName}</span>;
	} else if (what === 'newChat') {
		typeNode = newChatTypeText ? `${newChatTypeText} chat` : 'nový chat';
		targetNode = (
			<span>
				<span className="tGreen boldM">{messageAuthor || 'Někdo'}</span>
				{newChatNameText && <span className="tBlue boldM">{newChatNameText}</span>}
			</span>
		);
	} else if (what === 'comment') {
		typeNode = (
			<span>
				nový komentář k <span className="tBlue boldM">{data.title || 'tvojí události'}</span>
			</span>
		);
		targetNode = <span className="tGreen boldM">{fullName || 'Někdo'}</span>;
	} else if (what === 'reply') {
		typeNode = (
			<span>
				nová odpověď v <span className="tBlue boldM">{data.title || 'diskuzi'}</span>
			</span>
		);
		targetNode = <span className="tGreen boldM">{fullName || 'Někdo'}</span>;
	} else if (what === 'interest') {
		typeNode = 'nové zájmy';
		targetNode = <span className="tBlue boldM">{data.title || 'Tvoje událost'}</span>;
	} else if (what === 'eve_rating') {
		typeNode = 'nové hodnocení';
		targetNode = <span className="tBlue boldM">{data.title || 'Tvoje událost'}</span>;
	} else if (what === 'user_rating') {
		typeNode = 'nové hodnocení';
		targetNode = <span className="tGreen boldM">{fullName || 'Tvůj profil'}</span>;
	} else if (what === 'comm_rating') {
		typeNode = 'nové hodnocení';
		targetNode = <span className="boldM">{data.content || 'Tvůj komentář'}</span>;
	} else if (what === 'invite') {
		if (isOutgoingInvite) {
			typeNode = (
				<span>
					{inviteActionText} <span className="tBlue boldM">{inviteEventTitle || 'událost'}</span>
				</span>
			);
			targetNode = <span className="tGreen boldM">{fullName || 'Někdo'}</span>;
		} else {
			typeNode = (
				<span>
					pozvánka na <span className="tBlue boldM">{data.title || 'událost'}</span>
				</span>
			);
			targetNode = <span className="tGreen boldM">{fullName || 'Někdo'}</span>;
		}
	} else if (what === 'link') {
		typeNode = 'žádost o propojení';
		targetNode = <span className="tGreen boldM">{fullName || 'Uživatel'}</span>;
	} else if (what === 'accept') {
		typeNode = 'propojení přijato';
		targetNode = <span className="tGreen boldM">{fullName || 'Uživatel'}</span>;
	} else {
		typeNode = 'Upozornění';
		targetNode = <span className="boldM">Alert</span>;
	}

	// RENDER ------------------------------------------------------------------
	return (
		<alert-strip onClick={() => (isMessageToast && onToastClick ? onToastClick() : (setModes(prev => ({ menu: prev.menu ? null : true })), setStripMenu?.(modes.menu ? null : alert?.id)))} class={`flexCol marBotXxxs shaBlue boRadXxs justCen aliStart w100 posRel bInsetBlueTopXxs bHover pointer shaBot borTopLight `}>
			<strip-body class={`flexCen w100 ${!isToast ? 'padVerXs' : 'bsContentGlow shaMega boRadXs thickBors'}`}>
				{/* LEFT IMAGE --- */}
				<image-wrapper class={'posRel w25 mw14 miw8 marRigM'}>
					<img className={'w100 aspect168 boRadXxs'} src={thumbUrl} alt="" />
					<img className={'zinMaXl bgWhite mw5 posAbs bInsetBlueTopXs  cornerBotRightM padAllXxs boRadM bgTrans aspect1612  boRadXxs'} src={`/icons/alerts/${what === 'message' || what === 'newChat' ? 'comment' : what}.png`} alt="" />
				</image-wrapper>

				{/* RIGHT CONTENT --- */}
				<right-side class={`h100 flexCol padRightS justCen ${!isToast ? '' : 'padTopXxxs'}`}>
					<first-row class="flexRow gapXxs fs6 tGrey wrap w100">
						{createdText}
						<span className=" fs6 ">{typeNode}</span>
					</first-row>
					<span className="boldM lh1 textSha marRigXxs fs12 wordBreak ">{targetNode}</span>
					<second-row class="flexRow aliCen wrap textLeft">
						{subtitleNode}
						{originalNode}
					</second-row>
					{status.inter || status.refused || status.accepted ? <ContentIndis status={{ alertAccepted: Boolean(status.inter || status.accepted), alertRefused: status.refused === true }} thisIs={'alert'} isCardOrStrip={true} brain={brain} obj={{}} /> : null}
				</right-side>
			</strip-body>

			{/* MENU --- */}
			{modes.menu && !isMessageToast && (
				<AlertMenuStrip
					alert={alert}
					brain={brain}
					storeAlertsData={storeAlertsData}
					setMenuView={setMenuView}
					nowAt={'alerts'}
					modes={modes}
					setModes={setModes}
					onRemoveAlert={onRemoveAlert}
					status={status}
					setStatus={setStatus}
					buttons={(function () {
						const list = ['smazat'];
						const eventTypesWithActions = new Set(['interest', 'eve_rating', 'comment', 'reply', 'invite', 'comm_rating']);
						const hasEvent = Boolean(data?.event || alert?.target) && eventTypesWithActions.has(what);
						const hasUser = Boolean(data?.user || alert?.target) && new Set(['invite', 'link', 'accept', 'user_rating', 'comment', 'reply']).has(what);
						if (hasEvent) list.unshift('otevřít', 'náhled');
						if (hasUser || what === 'user_rating') list.unshift('profil');

						if (what === 'invite') {
							if (status.refused === true) {
								/* no-op */
							} else if (status.inter) list.unshift('účast', 'odmítnout');
							else list.unshift('přijmout', 'odmítnout');
						}

						const alreadyLinked = (brain.user.unstableObj || brain.user).linkUsers.some(link => link[0] == alert?.target);
						if (what === 'link' && !alreadyLinked) {
							if (status.refused === true) list.unshift('připojit');
							else list.unshift('přijmout', 'odmítnout');
						}
						if (['invite', 'link', 'accept'].includes(what)) list.push('galerie');
						return Array.from(new Set(list));
					})()}
				/>
			)}
		</alert-strip>
	);
}

const areEqual = (prev, next) => prev.alert === next.alert;
export default memo(AlertStrip, areEqual);
