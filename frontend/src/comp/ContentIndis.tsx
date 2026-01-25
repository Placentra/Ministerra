import { ratingSrc } from '../../sources';
const marks = { event: [-2, 1, 3, 5], user: [1, 5], comment: [-2, 1, 3, 5] };

// TODO pass sort, if its badges, display možná, určitě, tvoje atd.
// CONTENT INDICATORS COMPONENT DEFINITION ---
// Renders visual badges and status icons for events, users, and comments
function ContentIndis({ status, obj, isCardOrStrip, modes = {}, isSearch, isInvitations, isChats, thisIs, galleryMode = '', brain, isNewUser, manageMode, getPunishmentStatus, cols, hideAttenRating = false }: any) {
	// UNIFIED CHIP SIZING ---
	const chipFontClass = { 1: 'fs7', 2: 'fs7', 3: 'fs7', 4: 'fs6', 5: 'fs5' }[cols] || 'fs7';
	const chipClass = `${chipFontClass} bold textSha padHorXs hr1-5 boRadXxs tWhite`;
	const basicIndis = {
		people: status.surely > 0 ? `${Math.max(0, status.surely)}` : null,
		score: !isSearch && status.score > 0 ? Math.max(0, status.score) : null,
		comments: !isSearch && status.comments > 0 ? status.comments : null,
	};
	const isLast = thisIs === 'event' && isCardOrStrip && brain.user.openEve?.[brain.user.openEve.length - 1] === obj.id;
	const { active, expired, punish } = getPunishmentStatus?.(obj) || {};

	const optionals = {
		odstraněn: { val: manageMode && manageMode !== 'manage' && obj.role === 'spect', class: 'chipRed' },
		nový: { val: isNewUser, class: 'chipGreen' },
		umlčen: { val: manageMode !== 'punish' && isChats && punish === 'gag' && active, class: 'chipRed' },
		banován: { val: manageMode !== 'punish' && isChats && punish === 'ban' && active, class: 'chipDarkRed' },
		nedostupný: { val: (punish === 'block' && active) || status.unavail, class: 'chipDarkRed' },
		// zrušeno: { val: galleryMode && (galleryMode !== 'requests' ? obj.flag === 'can' : !status.linked), class: 'chipDarkRed' },
		smazáno: { val: galleryMode && obj.flag === 'del', class: 'chipDarkRed' },
		opuštěná: { val: galleryMode && thisIs === 'event' && !obj.owner, class: 'chipRed' },
		'trest skončil': { val: thisIs === 'chat' && punish !== 'kick' && expired, class: 'chipGreen' },
		'tvoje událost': { val: thisIs === 'event' && status.own && !galleryMode?.includes('Own'), class: 'chipDarkBlue' },
		mark: { val: isCardOrStrip && status.mark && ratingSrc[thisIs].rating[marks[thisIs].indexOf(status.mark)] && !hideAttenRating, class: 'chipLime' },
		vykopnut: { val: isChats && punish === 'kick', class: 'chipDarkRed' },
		[thisIs === 'comment' ? 'tvůj' : 'tvoje']: { val: thisIs !== 'event' && !galleryMode && status.own, class: 'chipGreen' },
		viděls: { val: !isSearch && status.opened && !galleryMode && !isLast, class: 'chipOrange' },
		nahlásils: { val: !isSearch && status.reported && !galleryMode, class: 'chipDarkRed' },
		opustils: { val: isSearch && obj.flag === 'del', class: 'chipRed' },
		opuštěn: { val: thisIs === 'chat' && obj.flag === 'del', class: 'chipRed' },
		žádost: { val: obj.flag === 'req', class: 'chipGreen' },
		pozván: { val: !galleryMode?.includes('invites') && obj.invited === true, class: 'chipPurple' },
		přijato: {
			val: (obj.linked === true && (galleryMode === 'requests' || status?.alertAccepted === true)) || (obj.invited === 'acc' && galleryMode === 'invitesIn') || Boolean(status?.alertAccepted === true),
			class: 'chipGreen',
		},
		odmítnuto: { val: Boolean(status?.alertRefused === true), class: 'chipRed' },
		'odmítnuto / zrušeno': { val: (obj.linked === false && !obj.unavail && galleryMode === 'requests') || (obj.invited === 'ref' && galleryMode === 'invitesIn'), class: 'chipRed' },
		ukončen: { val: obj.ended, class: 'chipDarkRed' },
		odchozí: { val: galleryMode === 'requests' && (status.linked === 'out' || obj.linked === 'out'), class: 'chipDarkBlue' },
		příchozí: { val: galleryMode === 'requests' && (status.linked === 'in' || obj.linked === 'in'), class: 'chipDarkGreen' },
		'viděls teď': { val: !status.embeded && isLast && !galleryMode && !isSearch && !isInvitations, class: 'chipDarkRed' },
		bloknuls: { val: punish === 'block' && !active, class: 'chipRed' },
		odblokován: { val: galleryMode === 'blocks' && punish !== 'block' && !active, class: 'chipGreen' },
		připojen: { val: !obj.trusts && obj.linked === true && isCardOrStrip && galleryMode !== 'links', class: 'chipDarkGreen' },
		důvěrník: { val: obj.trusts, class: 'chipDarkPurple' },
	};

	const someOptionals = Object.values(optionals).some(indi => indi.val);
	const someBasics = Object.values(basicIndis).some(indi => indi);

	return (
		<indicators-div class="flexInline  aliCen justCen noPoint" style={{ display: 'contents' }}>
			{/* INTERREST INDI - CARD AND GALLERY ------------------------------------ */}
			{((thisIs === 'alert' && status.inter) || (thisIs === 'event' && ['sur', 'may', 'int'].includes(status.inter) && (galleryMode !== 'futuInt' || status.inter !== 'int') && !hideAttenRating)) && (
				<inter-indi class="flexInline aliCen marRigXxs" style={{ display: 'contents' }}>
					<span className={`${status.inter === 'may' ? 'chipBlue' : status.inter === 'sur' ? 'chipGreen' : 'chipOrange'} ${isCardOrStrip ? chipClass : 'fs10 hr2 flexInline padHorS boldM tWhite'} marRigXxs`}>{status.inter === 'sur' ? 'určitě jdeš' : status.inter === 'may' ? 'možná jdeš' : 'zajímá tě'}</span>
					{status.interPriv && status.interPriv !== 'pub' && <span className={`padHorXs ${chipFontClass} bold textSha opacityL noWrap`}>{{ lin: 'spojenci', own: 'jen autor', tru: 'důvěrníci' }[status.interPriv]}</span>}
				</inter-indi>
			)}
			{/* OPTIONAL INDIS --------------------------------------------- */}
			{someOptionals && (
				<optional-indis class="flexInline aliCen posRel" style={{ display: 'contents' }}>
					{Object.keys(optionals)
						.filter(indi => optionals[indi].val)
						.map(indi => (
							<span key={indi} className={`${optionals[indi].class} ${isCardOrStrip ? chipClass : 'fs10 hr2 flexInline padHorS boldM tWhite'} marRigXxs`}>
								{indi !== 'mark' ? indi : optionals[indi].val}
							</span>
						))}
				</optional-indis>
			)}
			{/* BASIC INDIS ----------------------------------------------- */}
			{someBasics && galleryMode !== 'requests' && (
				<basic-indis class={` flexInline padVerXxxs aliCen justCen `} style={{ display: 'contents' }}>
					{Object.keys(basicIndis)
						.filter(indi => basicIndis[indi])
						.map(indi => {
							const ElementName = `${indi}-div`;
							return (
								<ElementName key={indi} class={`flexInline aliCen justCen  marRigS zinMax`}>
									<img className={`${isCardOrStrip ? 'mh1-5  ' : '   mw3'} marRigXxs aspect1611 posRel`} src={`/icons/${indi}.png`} />
									<span className={`boldM ${isCardOrStrip ? 'fs11' : 'fs11'}  textSha`}>{basicIndis[indi]}</span>
									{indi === 'people' && status.maybe > 0 && <span className={`textSha boldXs marLefXxs ${isCardOrStrip ? 'fs11' : 'fs11'}`}>{`${status.maybe ? `+${status.maybe}` : ''}`}</span>}
								</ElementName>
							);
						})}
				</basic-indis>
			)}
		</indicators-div>
	);
}

export default ContentIndis;
