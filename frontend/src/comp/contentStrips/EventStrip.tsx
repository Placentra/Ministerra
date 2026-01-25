import { humanizeDateTime } from '../../../helpers';
import { useState, memo, useLayoutEffect } from 'react';

import { FRIENDLY_MEETINGS } from '../../../../shared/constants';
import ContentIndis from '../ContentIndis';
import EveMenuStrip from '../menuStrips/EveMenuStrip';
import EventCard from '../EventCard.tsx';

function EventStrip(props) {
	const { obj = {}, brain, galleryMode, isMobile, stripMenu, setStripMenu, isSearch, isPastEvent, isInvitations, superMan, isSelected, setGalleryContent, numOfCols } = props;
	// UNIFIED CHIP SIZING ---
	const chipClass = `fs7 bold textSha padHorXs hr1-5 boRadXxs tWhite`;
	const [modes, setModes] = useState({ inter: false, share: false, menu: false, evePreview: false, protocol: false, invites: false, invitees: false, invitors: false, feedback: false });
	const imgVers = obj.imgVers?.toString().split('_')[0] || 0;
	const invitesUsersSrc = (() => {
		if (!(galleryMode && galleryMode.includes('invites'))) return [];
		const src = obj.invites;
		if (Array.isArray(src)) return src;
		if (src && typeof src === 'object') return src[galleryMode === 'invitesIn' ? 'in' : 'out'] || [];
		const fallback = brain?.user?.[galleryMode]?.[obj.id];
		return Array.isArray(fallback) ? fallback : [];
	})();

	const [status, setStatus] = useState({
		score: obj.score,
		comments: obj.comments,
		surely: obj.surely,
		maybe: obj.maybe,
		inter: obj.inter,
		canceled: obj.canceled,
		deleted: obj.state === 'del',
		interPriv: obj.interPriv,
		own: obj.own,
		invited: obj.invited,
		opened: brain.user.id && brain.user.openEve?.includes(obj.id),
		isMeeting: FRIENDLY_MEETINGS.has(obj.type),
		copied: false,
		isPastEvent,
	});

	// GLOBAL MENU TOGGLE --------------------------------------------------------
	useLayoutEffect(() => {
		const shouldBeOpen = stripMenu === obj.id;
		setModes(prev => {
			if (prev.menu === shouldBeOpen) return prev;
			return { ...prev, menu: shouldBeOpen, protocol: false, evePreview: false, feedback: false };
		});
	}, [stripMenu, obj.id]);

	// SYNC CANCELED/DELETED STATE FROM OBJ ------------------------------------
	useLayoutEffect(() => {
		if (obj.canceled !== status.canceled || (obj.state === 'del') !== status.deleted) setStatus(prev => ({ ...prev, canceled: obj.canceled, deleted: obj.state === 'del' }));
	}, [obj.canceled, obj.state]);

	const hideMenu = modes.menu && (modes.protocol || modes.evePreview || modes.invites || modes.delete || modes.cancel || modes.inter || modes.feedback || modes.deletePast || modes.invitees || modes.invitors);
	const resetSubModes = () => setModes(prev => ({ ...prev, protocol: false, evePreview: false, invites: false, delete: false, cancel: false, inter: false, feedback: false, deletePast: false, invitees: false, invitors: false }));
	const closeEverything = () => {
		setStripMenu(null);
		setModes(prev => ({ ...prev, menu: false, protocol: false, evePreview: false, invites: false, delete: false, cancel: false, inter: false, feedback: false, deletePast: false, invitees: false, invitors: false }));
	};

	return (
		<event-strip
			onClick={() => {
				if (isInvitations) return superMan({ mode: 'selectEvent', obj });
				if (modes.menu) return closeEverything();
				setModes(prev => {
					setStripMenu(obj.id);
					return { ...prev, menu: true, evePreview: false, inter: false };
				});
			}}
			class={`${(() => {
				const invitedFlag = (() => {
					if (obj.invited) return obj.invited;
					if (galleryMode === 'invitesIn') {
						if (invitesUsersSrc.some(u => u && u.flag === 'acc')) return 'acc';
						if (invitesUsersSrc.length > 0 && invitesUsersSrc.every(u => u && u.flag === 'ref')) return 'ref';
					}
					return undefined;
				})();
				return galleryMode === 'invitesIn' && invitedFlag === 'acc' ? 'bInsetGreen' : galleryMode === 'invitesIn' && invitedFlag === 'ref' ? 'bInsetRed' : isSelected ? 'bInsetBlue shaBot posRel borBot8 bor3 boRadXxs Halo' : '';
			})()}   mw130 w100 shaBlue marBotXxxs boRadXxs ${!isMobile && !modes.menu && !modes.evePreview ? 'padVerXxs' : modes.menu ? 'shaMega  borTop    ' : ''} ${modes.protocol || modes.menu || modes.evePreview ? ' boRadXs  shaStrong     bInsetBlueTopXs  boRadXs   posRel' : ''} ${isPastEvent ? 'bgTransXxs' : modes.evePreview ? '' : ''} flexCol posRel bHover2  pointer shaBlueLight  aliStart`}>
			<strip-body class={`${modes.menu ? 'marBotXxs' : ''} flexRow aliStart fPadHorXxxs  marAuto bgWhite  zinMaXl padBotXxs  w100`}>
				{/* IMAGE ------------------------------------------------------ */}
				<image-wrapper class={`${modes.menu ? 'bsContentGlow bDarkBlue  boRadM' : ''} bHover  selfStart marTopXs textAli  w18 mw12 posRel marRigS miw10   ${obj.type.startsWith('a') ? 'aspect168 cover' : 'aspect168'} ${isPastEvent ? 'opacityM' : ''} borRed shaBot boRadXxs`}>
					<img
						onClick={e => {
							e.stopPropagation();
							if (hideMenu) return resetSubModes();
							setModes(prev => {
								const newMenuState = !prev.menu;
								setStripMenu(newMenuState ? obj.id : null);
								return { ...prev, menu: newMenuState, inter: false, protocol: false };
							});
						}}
						className={`w100 h100 posRel boRadXxs`}
						src={obj.imgVers && !obj.type.startsWith('a') ? `${import.meta.env.VITE_BACK_END}/public/events/${obj.id}_${!obj.own ? `${Math.floor(Math.random() * 30) + 1}` : imgVers}S.webp` : obj.type.startsWith('a') ? `/covers/${obj.type}.png` : '/icons/placeholdergood.png'}
						alt=""
					/>
					{hideMenu && (
						<span className="bold fs8 posRel posAbs opacityL marBotXxxs padVerXxxs bRed tWhite textAli padHorXs w100 botCen textSha boRadXxxs zinMaXl pointer" onClick={e => (e.stopPropagation(), resetSubModes())}>
							zpět na menu
						</span>
					)}
				</image-wrapper>

				{/* RIGHT SIDE ------------------------------------------------------ */}
				<right-side class={`h100 flexCol justStart aliStart h100 padTopXs  `}>
					<second-row class={`flexRow aliCen wrap textLeft marTopXxxs marBotXxxs  `}>
						<span className={`fs11 boldM tDarkBlue inline marRigS lh1 ${isPastEvent ? 'tRed' : ''}`}>{humanizeDateTime({ dateInMs: obj.starts })}</span>
						{!isSearch && (obj.location?.startsWith('+') || (!obj.location && !obj.place)) && (
							<around-indi class={`flexInline aliCen posRel down1 marRigXxs`}>
								<span className={`chipPurple ${chipClass}`}>{obj.location?.startsWith('+') ? 'v okolí' : 'kdekoliv'}</span>
							</around-indi>
						)}
						<span className={`${`fs11  marRigS  ${(isSearch && obj.starts < Date.now()) || isPastEvent ? 'tRed boldM' : 'tDarkGreen boldS'}`} inline marRigXs `}>{`${obj.place ? `${obj.place} -` : ''} ${obj.city}`}</span>
					</second-row>

					{/* TITLE (first row) ---------------------------------------------- */}
					<span className={`boldM lh1-2 textSha marRigXxs marBotXxxxxs wordBreak ${isPastEvent ? 'tDarkGray' : ''}`}>
						{status.deleted && <strong className="xBold tRed fs10  marRigXs inlineBlock">SMAZÁNO! </strong>}
						{status.canceled && <strong className="xBold tRed fs10 marRigXs inlineBlock">ZRUŠENO! </strong>}
						<span className={` ${numOfCols > 1 ? 'fs12' : 'fs15'} boldM `}>{obj.title}</span>
					</span>

					{/* INDICATORS (third row) --------------------------------------------------- */}
					<third-row class="flexInline">
						<ContentIndis status={status} isSearch={isSearch} thisIs={'event'} galleryMode={galleryMode} isInvitations={isInvitations} s isCardOrStrip={true} modes={modes} brain={brain} obj={obj} />
					</third-row>

					{/* USER ROW (multiple users who invited) ---------------------------------------------- */}
					{galleryMode && galleryMode.includes('invites') && invitesUsersSrc.length > 0 && (
						<user-row class="flexRow marTopXxs marBotXxs">
							<span className="fs6 tDarkBlue bold marRigXs">{galleryMode === 'invitesIn' ? 'Pozvali Tě:' : 'Pozval jsi:'}</span>
							<images-row class="flexInline fs6 marRightS">
								{invitesUsersSrc
									.slice(0, 3)
									.filter(inviter => inviter && inviter.imgVers != null && inviter.imgVers !== '')
									.map(({ id, imgVers, first, last }, index) => {
										return `${first} ${last}`;
									})
									.join(', ')}
							</images-row>
							{invitesUsersSrc.length > 3 && <strong className="fs8"> ... + {invitesUsersSrc.length - 3} more</strong>}
						</user-row>
					)}
				</right-side>
			</strip-body>

			{/* MENU STRIP + PREVIEW CARD ----------------------------------------------- */}
			{modes.menu && (
				<bottom-part onClick={e => e.stopPropagation()} class="w100">
					<EveMenuStrip {...{ isCardOrStrip: true, status, setStatus, modes, brain, setModes, galleryMode, isSearch, obj, isPastEvent, userCardSetModes: setModes, setGalleryContent }} />

					{modes.evePreview && <EventCard brain={brain} isPreview={true} obj={obj} isPastEvent={isPastEvent} isSearch={isSearch} />}
				</bottom-part>
			)}
		</event-strip>
	);
}

function areEqual(prev, next) {
	const propsEqual = prev.obj === next.obj && prev.isSelected === next.isSelected && prev.stripMenu === next.stripMenu && prev.isPastEvent === next.isPastEvent && prev.obj.invites === next.obj.invites && prev.obj.canceled === next.obj.canceled && prev.obj.state === next.obj.state && prev.numOfCols === next.numOfCols; // CHECK CANCELED/DELETED ---
	return propsEqual;
}
export default memo(EventStrip, areEqual);
