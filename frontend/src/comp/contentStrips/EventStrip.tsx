import { humanizeDateTime } from '../../../helpers';
import { useState, memo, useLayoutEffect } from 'react';

import { FRIENDLY_MEETINGS } from '../../../../shared/constants';
import ContentIndis from '../ContentIndis';
import EveMenuStrip from '../menuStrips/EveMenuStrip';
import EventCard from '../EventCard';

function EventStrip(props) {
	const { obj = {}, brain, galleryMode, isMobile, stripMenu, setStripMenu, isSearch, isPastEvent, isInvitations, superMan, isSelected, setGalleryContent, numOfCols } = props;
	const [modes, setModes] = useState({ inter: false, share: false, menu: false, evePreview: false, protocol: false, invites: false, invitees: false, invitors: false, feedback: false });
	const imgVers = obj.imgVers?.toString().split('_')[0] || 0;
	// STABLE RANDOM FOR PLACEHOLDER ASSETS ---
	const stableRandom = (parseInt(String(obj.id).slice(-4), 36) % 30) + 1;
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

	return (
		<event-strip
			onClick={() => {
				if (isInvitations) return superMan({ mode: 'selectEvent', obj });
				setModes(prev => {
					const newMenuState = !prev.menu;
					setStripMenu(newMenuState ? obj.id : null);
					return { ...prev, menu: newMenuState, evePreview: false, inter: false };
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
				return galleryMode === 'invitesIn' && invitedFlag === 'acc'
					? 'bInsetGreen'
					: galleryMode === 'invitesIn' && invitedFlag === 'ref'
					? 'bInsetRed'
					: isSelected
					? 'bInsetBlue shaBot posRel borBot8 bor3 boRadXxs Halo'
					: '';
			})()}   mw130 w100 shaBlue marBotXxxs boRadXxs ${!isMobile && !modes.menu && !modes.evePreview ? 'padVerXxs' : modes.menu ? 'shaMega  borTop    ' : ''} ${
				modes.protocol || modes.menu || modes.evePreview ? ' boRadXs  shaStrong     bInsetBlueTopXs  boRadXs   posRel' : ''
			} ${isPastEvent ? 'bgTransXxs' : modes.evePreview ? '' : ''} flexCol posRel bHover2  pointer shaBlueLight  aliStart`}>
			<strip-body class={`${modes.menu ? 'marBotXxs' : ''} flexRow aliStart fPadHorXxxs  marAuto bgWhite  zinMaXl padBotXxs  w100`}>
				{/* IMAGE ------------------------------------------------------ */}
				<img
					onClick={e => {
						e.stopPropagation();
						setModes(prev => {
							const newMenuState = !prev.menu;
							setStripMenu(newMenuState ? obj.id : null);
							return { ...prev, menu: newMenuState, inter: false, protocol: false };
						});
					}}
					className={`${modes.menu ? 'bsContentGlow bDarkBlue  boRadM' : ''}  selfStart marTopXs  w18 mw12 posRel marRigS miw10   ${
						obj.type.startsWith('a') ? 'aspect167 cover' : 'aspect1612'
					} ${isPastEvent ? 'opacityM' : ''} borRed shaBot boRadXxs`}
					src={
						obj.imgVers && !obj.type.startsWith('a')
							? `${import.meta.env.VITE_BACK_END}/public/events/${obj.id}_${!obj.own ? stableRandom : imgVers}S.webp`
							: obj.type.startsWith('a')
							? `/covers/${obj.type}.png`
							: '/icons/placeholdergood.png'
					}
					alt=''
				/>

				{/* RIGHT SIDE ------------------------------------------------------ */}
				<right-side class={`h100 flexCol justStart aliStart h100 padTopXs  `}>
					{/* ADDRESS AND DATES (second row) -------------------------------------------------- */}
					<second-row class={`flexRow aliCen wrap textLeft marTopXxxs marBotXxxs  `}>
						<span className={`fs8 boldM tDarkBlue inline marRigS lh1 ${isPastEvent ? 'tRed' : ''}`}>{humanizeDateTime({ dateInMs: obj.starts })}</span>
						{!isSearch && (obj.location?.startsWith('+') || (!obj.location && !obj.place)) && (
							<around-indi class={` boRadXxs  posRel down1 marRigXxs`}>
								<span className={`boldS padHorXxs fs6 textSha tWhite  flewRow bTeal textSha`}>{obj.location?.startsWith('+') ? 'v okolí' : 'kdekoliv'}</span>
							</around-indi>
						)}
						<span className={`${`fs8  marRigS  ${(isSearch && obj.starts < Date.now()) || isPastEvent ? 'tRed boldM' : 'tDarkGreen boldS'}`} inline marRigXs `}>{`${
							obj.place ? `${obj.place} -` : ''
						} ${obj.city}`}</span>
					</second-row>

					{/* TITLE (first row) ---------------------------------------------- */}
					<span className={`boldM lh1-2 textSha marRigXxs marBotXxxxxs ${isPastEvent ? 'tDarkGray' : ''}`}>
						{status.deleted && <strong className='xBold tRed fs10  marRigXs inlineBlock'>SMAZÁNO! </strong>}
						{status.canceled && <strong className='xBold tRed fs10 marRigXs inlineBlock'>ZRUŠENO! </strong>}
						<span className={` ${numOfCols > 1 ? 'fs10' : 'fs8'} boldM `}>{obj.title}</span>
					</span>

					{/* INDICATORS (third row) --------------------------------------------------- */}
					<third-row class='flexInline'>
						<ContentIndis
							status={status}
							isSearch={isSearch}
							thisIs={'event'}
							galleryMode={galleryMode}
							isInvitations={isInvitations}
							isCardOrStrip={true}
							modes={modes}
							brain={brain}
							obj={obj}
						/>
					</third-row>

					{/* USER ROW (multiple users who invited) ---------------------------------------------- */}
					{galleryMode && galleryMode.includes('invites') && invitesUsersSrc.length > 0 && (
						<user-row class='flexRow marTopXxs marBotXxs'>
							<span className='fs6 tDarkBlue bold marRigXs'>{galleryMode === 'invitesIn' ? 'Pozvali Tě:' : 'Pozval jsi:'}</span>
							<images-row class='flexInline fs6 marRightS'>
								{invitesUsersSrc
									.slice(0, 3)
									.filter(inviter => inviter && inviter.imgVers != null && inviter.imgVers !== '')
									.map(({ id, imgVers, first, last }, index) => {
										return `${first} ${last}`;
									})
									.join(', ')}
							</images-row>
							{invitesUsersSrc.length > 3 && <strong className='fs8'> ... + {invitesUsersSrc.length - 3} more</strong>}
						</user-row>
					)}
				</right-side>
			</strip-body>

			{/* MENU STRIP + PREVIEW CARD ----------------------------------------------- */}
			{modes.menu && (
				<bottom-part onClick={e => e.stopPropagation()} class='w100'>
					<EveMenuStrip {...{ isCardOrStrip: true, status, setStatus, modes, brain, setModes, galleryMode, isSearch, obj, isPastEvent, userCardSetModes: setModes, setGalleryContent }} />

					{modes.evePreview && <EventCard brain={brain} isPreview={true} obj={obj} isPastEvent={isPastEvent} isSearch={isSearch} />}
				</bottom-part>
			)}
		</event-strip>
	);
}

function areEqual(prev, next) {
	const propsEqual =
		prev.obj === next.obj &&
		prev.isSelected === next.isSelected &&
		prev.stripMenu === next.stripMenu &&
		prev.isPastEvent === next.isPastEvent &&
		prev.obj.invites === next.obj.invites &&
		prev.obj.canceled === next.obj.canceled &&
		prev.obj.state === next.obj.state; // CHECK CANCELED/DELETED ---
	return propsEqual;
}
export default memo(EventStrip, areEqual);
