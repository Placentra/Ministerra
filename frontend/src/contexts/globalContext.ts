import { createContext } from 'react';

// GLOBAL CONTEXT SINGLETON -----------------------------------------------------
// Steps: create one shared context object so HMR/remounts don’t accidentally create multiple incompatible contexts; consumers import the same symbol everywhere.
export const globalContext = createContext<any>({} as any);

export default globalContext;
