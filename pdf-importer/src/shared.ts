/** View points: top-left origin, y down, page rotation applied. */
export type Vec = [number, number];
export type Dim = { a: Vec; b: Vec; writtenMm: number };
export type Calibration = { scale: number; mmPerPt: number; offsetMm: number; chosen: 50 | 100; dims: Dim[]; verified: boolean };
