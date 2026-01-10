// WELCOME COMPONENT -----------------------------------------------------------
// First step of introduction flow. Will contain password confirmation
// so PDK can be derived before profile data is stored.

function Welcome({ data, superMan, inform }) {
	return (
		<welcome-comp class='block w100 marAuto mw120 padAllS'>
			{/* WELCOME HEADER --- */}
			<h1 className='fs24 xBold textSha marBotS tBlue'>Vítej v Ministerře</h1>

			{/* PLACEHOLDER --- */}
			<p className='fs12 tGrey marBotM'>Tato sekce bude obsahovat potvrzení hesla pro bezpečné uložení dat.</p>
		</welcome-comp>
	);
}

export default Welcome;
