import EntranceForm from '../comp/EntranceForm';

// ENTRANCE PAGE WITH BACKGROUND IMAGE AND CENTERED FORM ---------------------------
function Entrance({ brain }) {
	return (
		<entrance-page class={'  bInsetBlueDark posRel w100 hvh100 mhvh100 mihvh100 flexCol zinMaXl  '}>
			{/* TOP LOGO BADGE (STATIC, NO ACTION) ------------------------------------------ */}
			<top-logo class='marAuto posFix zinMenu topCen w90 textAli pointer'>
				<div className='w100 mw110 trapezoid-logo-background hvh1 bBlue posAbs topCen marAuto' />
				<div className='w80 mw70 flexCol aliCen trapezoid-logo-background marAuto posRel' style={{ overflow: 'hidden' }}>
					<h1 className='fsD lh1 boldM inlineBlock marBotXxxs marTopXxxs posRel tWhite' style={{ zIndex: 1 }}>
						Ministerra
					</h1>
				</div>
			</top-logo>
			{/* BACKGROUND IMAGE ------------------------------------------ */}
			<img className='posAbs topCen hvw80 mh60 cover zin1 	maskLow w100' src={`${import.meta.env.VITE_FRONT_END}/headers/namestiSvobody.jpg`} />
			<EntranceForm {...{ brain }} />
		</entrance-page>
	);
}

export default Entrance;
