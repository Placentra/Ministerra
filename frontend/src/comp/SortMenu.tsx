import useCentralFlex from '../hooks/useCentralFlex';

const src = {
	content: { en: ['popular', 'earliest', 'nearest', 'intimate', 'busy'], cz: ['oblíbené', 'brzké', 'blízké', 'intimní', 'rušné'] },
	discussion: { en: ['recent', 'popular', 'hottest', 'oldest', '+replies'], cz: ['nové', 'nejlepší', 'živé', 'staré', '+odpovědi'] },
	futu: { en: ['earliest', 'latest', 'score'], cz: ['nejbližší', 'vzdálené', 'oblíbené'] },
	past: { en: ['recent', 'oldest'], cz: ['nedávné', 'nejstarší'] },
	links: { en: ['recent', 'oldest', 'first', 'last', 'incoming', 'outgoing'], cz: ['nejnovější', 'nejstarší', 'jméno', 'příjmení', 'příchozí', 'odchozí'] },
	requests: { en: ['recent', 'oldest', 'first', 'last'], cz: ['nejnovější', 'nejstarší', 'jméno', 'příjmení'] },
	invitesIn: { en: ['recent', 'oldest', 'earliest', 'latest'], cz: ['nejnovější', 'nejstarší', 'brzké', 'pozdější'] },
	invitesOut: { en: ['recent', 'oldest', 'earliest', 'latest'], cz: ['nejnovější', 'nejstarší', 'brzké', 'pozdější'] },
	blocks: { en: ['recent', 'oldest'], cz: ['nejnovější', 'nejstarší'] },
};
function SortMenu(props) {
	const { mode, selSort, fadedIn = ['SortMenu'], superMan, hideSort = [], brain, isGallery, setShow } = props;
	if (brain && brain.user.unstableObj && mode === 'links') hideSort.push(...['recent', 'oldest']);
	const targetProp = mode.startsWith('futu') ? 'futu' : mode.startsWith('past') ? 'past' : mode,
		visibleItems = src[targetProp].cz.filter((_, i) => !hideSort.some(h => src[targetProp].en.indexOf(h) === i)),
		bWidth = useCentralFlex('sortMenu', [mode, hideSort.length], null, visibleItems.length);

	return (
		<sort-menu
			class={`fadingIn ${fadedIn.includes('SortMenu') || mode === 'content' ? 'fadedIn ' : ''} ${isGallery ? 'posRel boRadS overHidden upLittle mw110 fsC ' : ''}  ${
				mode === 'discussion' ? 'mw60   w90  ' : mode === 'content' ? '  posRel marTopS w100 ' : 'bPadVerM'
			}  flexCen  posRel marAuto bInsetBlueTop     `}>
			{visibleItems.map((b, i) => {
				const eng = src[targetProp].en[src[targetProp].cz.indexOf(b)],
					isSelected = Array.isArray(selSort) ? selSort[0] === eng : selSort === eng;
				return (
					<button
						key={b}
						name={b}
						style={{ maxWidth: bWidth }}
						onClick={async () => {
							if (isGallery || mode === 'content') superMan('sort', eng), mode === 'content' && setShow(prev => ({ ...prev, sorts: false }));
							else if (mode !== 'discussion' && selSort !== eng) superMan('selSort', eng);
							else {
								if (eng === '+replies') superMan({ mode: 'selSort', sort: 'replies' });
								else selSort[0] !== eng && superMan({ mode: 'selSort', sort: eng });
							}
						}}
						className={`${isSelected || (eng === '+replies' && selSort[1]) ? '  fs20  bBlue tWhite borTop   posRel  xBold' : '   textSha fs12 '} grow  h100 ${
							mode === 'discussion' ? 'bHover padVerXxs' : 'hvw10 mh5'
						}  grow bgTransXs borTopLight `}>
						{isGallery && selSort === eng ? 'zpátky' : b}
					</button>
				);
			})}
		</sort-menu>
	);
}

export default SortMenu;
