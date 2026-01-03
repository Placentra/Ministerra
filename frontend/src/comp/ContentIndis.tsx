import { ratingSrc } from '../../sources';
const marks = { event: [-2, 1, 3, 5], user: [1, 5], comment: [-2, 1, 3, 5] };

// TODO pass sort, if its badges, display možná, určitě, tvoje atd.
// CONTENT INDICATORS COMPONENT DEFINITION ---
// Renders visual badges and status icons for events, users, and comments
function ContentIndis({ status, obj, isCardOrStrip, modes = {}, isSearch, isInvitations, isChats, thisIs, galleryMode = '', brain, isNewUser, manageMode, getPunishmentStatus }: any) {
	const basicIndis = {
		people: status.surely > 0 ? `${Math.max(0, status.surely)}` : null,
		score: !isSearch && status.score > 0 ? Math.max(0, status.score) : null,
		comments: !isSearch && status.comments > 0 ? status.comments : null,
	};
	const isLast = thisIs === 'event' && isCardOrStrip && brain.user.openEve?.[brain.user.openEve.length - 1] === obj.id;
	const { active, expired, punish } = getPunishmentStatus?.(obj) || {};

	const optionals = {
		odstraněn: { val: manageMode && manageMode !== 'manage' && obj.role === 'spect', class: 'bRed' },
		nový: { val: isNewUser, class: 'bGreen' },
		umlčen: { val: manageMode !== 'punish' && isChats && punish === 'gag' && active, class: 'bRed' },
		banován: { val: manageMode !== 'punish' && isChats && punish === 'ban' && active, class: 'bDarkRed' },
		nedostupný: { val: (punish === 'block' && active) || status.unavail, class: 'bDarkRed' },
		// zrušeno: { val: galleryMode && (galleryMode !== 'requests' ? obj.flag === 'can' : !status.linked), class: 'bDarkRed' },
		smazáno: { val: galleryMode && obj.flag === 'del', class: 'bDarkRed' },
		opuštěná: { val: galleryMode && thisIs === 'event' && !obj.owner, class: 'bRed' },
		'trest skončil': { val: thisIs === 'chat' && punish !== 'kick' && expired, class: 'bGreen' },
		'tvoje událost': { val: thisIs === 'event' && status.own && !galleryMode?.includes('Own'), class: 'bDarkBlue bor2' },
		mark: { val: isCardOrStrip && !modes.actions && status.mark && ratingSrc[thisIs].rating[marks[thisIs].indexOf(status.mark)], class: 'bInsetBlueBotXl' },
		vykopnut: { val: isChats && punish === 'kick', class: 'bDarkRed' },
		[thisIs === 'comment' ? 'tvůj' : 'tvoje']: { val: thisIs !== 'event' && !galleryMode && status.own, class: 'bGreen marRigXs' },
		viděls: { val: !isSearch && status.opened && !galleryMode && !isLast, class: 'bOrange' },
		nahlásils: { val: !isSearch && status.reported && !galleryMode, class: 'bDarkRed' },
		opustils: { val: isSearch && obj.flag === 'del', class: 'bRed' },
		opuštěn: { val: thisIs === 'chat' && obj.flag === 'del', class: 'bRed' },
		žádost: { val: obj.flag === 'req', class: 'bGreen' },
		pozván: { val: !galleryMode?.includes('invites') && obj.invited === true, class: 'bPurple' },
		přijato: {
			val:
				(obj.linked === true && (galleryMode === 'requests' || status?.alertAccepted === true)) ||
				(obj.invited === 'acc' && galleryMode === 'invitesIn') ||
				Boolean(status?.alertAccepted === true),
			class: 'bGreen',
		},
		odmítnuto: { val: Boolean(status?.alertRefused === true), class: 'bRed' },
		'odmítnuto / zrušeno': { val: (obj.linked === false && !obj.unavail && galleryMode === 'requests') || (obj.invited === 'ref' && galleryMode === 'invitesIn'), class: 'bRed' },
		ukončen: { val: obj.ended, class: 'bDarkRed' },
		odchozí: { val: galleryMode === 'requests' && (status.linked === 'out' || obj.linked === 'out'), class: 'bDarkBlue' },
		příchozí: { val: galleryMode === 'requests' && (status.linked === 'in' || obj.linked === 'in'), class: 'bDarkGreen' },
		poslední: { val: !status.embeded && isLast && !galleryMode && !isSearch && !isInvitations, class: 'bDarkRed' },
		bloknuls: { val: punish === 'block' && !active, class: 'bRed' },
		odblokován: { val: galleryMode === 'blocks' && punish !== 'block' && !active, class: 'bGreen' },
		připojen: { val: !obj.trusts && obj.linked === true && isCardOrStrip && galleryMode !== 'links', class: 'bDarkGreen' },
		důvěrník: { val: obj.trusts, class: 'bDarkPurple' },
	};

	const someOptionals = Object.values(optionals).some(indi => indi.val);
	const someBasics = Object.values(basicIndis).some(indi => indi);

	return (
		<indicators-div class='flexInline noWrap  aliCen justCen noPoint'>
			{/* INTERREST INDI IN GALLERY ------------------------------------ */}
			{((thisIs === 'alert' && status.inter) ||
				((galleryMode || isSearch) && thisIs === 'event' && ['sur', 'may', 'int'].includes(status.inter) && (galleryMode !== 'futuInt' || status.inter !== 'int'))) && (
				<inter-indi class='flexInline aliCen padTopXxxs marRigS borRight '>
					<span className={`bold padHorXs fs5 hr1-5  textSha tWhite  ${status.inter === 'may' ? 'bBlue' : status.inter === 'sur' ? 'bGreen' : 'bOrange'}`}>
						{status.inter === 'sur' ? 'určitě' : status.inter === 'may' ? 'možná' : 'sleduješ'}
					</span>
					{status.interPriv && status.interPriv !== 'pub' && (
						<span className='padHorXs fs5 bold textSha borRed opacityL noWrap'>{{ lin: 'spojenci', own: 'jen autor', tru: 'důvěrníci' }[status.interPriv]}</span>
					)}
				</inter-indi>
			)}
			{/* OPTIONAL INDIS --------------------------------------------- */}
			{someOptionals && (
				<optional-indis class='flexInline padVerXxxs aliCen posRel'>
					{Object.keys(optionals)
						.filter(indi => optionals[indi].val)
						.map(indi => (
							<span key={indi} className={`${optionals[indi].class} ${isCardOrStrip ? 'fs7 padVerXxxxs boRadXxs bold' : 'fs11 hr2 flexInline padHorS boldM'} opacityL padHorXs tWhite`}>
								{indi !== 'mark' ? indi : optionals[indi].val}
							</span>
						))}
				</optional-indis>
			)}
			{/* BASIC INDIS ----------------------------------------------- */}
			{someBasics && galleryMode !== 'requests' && (
				<basic-indis class={` flexInline padVerXxxs aliCen justCen `}>
					{Object.keys(basicIndis)
						.filter(indi => basicIndis[indi])
						.map(indi => {
							const ElementName = `${indi}-div`;
							return (
								<ElementName key={indi} class={`flexInline aliCen justCen  marRigS zinMax`}>
									<img className={`${isCardOrStrip ? 'mh1-5  ' : '   mw3'} marRigXxs aspect1611 posRel`} src={`/icons/${indi}.png`} />
									<span className={`boldM ${isCardOrStrip ? 'fs11' : 'fs11'}  textSha`}>{basicIndis[indi]}</span>
									{indi === 'people' && status.maybe > 0 && (
										<span className={`textSha boldXs marLefXxs ${isCardOrStrip ? 'fs11' : 'fs11'}`}>{`${status.maybe ? `+${status.maybe}` : ''}`}</span>
									)}
								</ElementName>
							);
						})}
				</basic-indis>
			)}
		</indicators-div>
	);
}

export default ContentIndis;
