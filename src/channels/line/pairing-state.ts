export interface LinePairingState {
  pairingQrText: string | null;
  pairingQrSvg: string | null;
  pairingUrl: string | null;
  pincode: string | null;
  error: string | null;
  updatedAt: string | null;
}

let currentState: LinePairingState = {
  pairingQrText: null,
  pairingQrSvg: null,
  pairingUrl: null,
  pincode: null,
  error: null,
  updatedAt: null,
};

export function setLinePairingQr(params: {
  text: string;
  svg: string;
  url: string;
}): void {
  currentState = {
    pairingQrText: params.text,
    pairingQrSvg: params.svg,
    pairingUrl: params.url,
    pincode: null,
    error: null,
    updatedAt: new Date().toISOString(),
  };
}

export function setLinePairingPincode(pincode: string): void {
  currentState = {
    ...currentState,
    pincode,
    error: null,
    updatedAt: new Date().toISOString(),
  };
}

export function setLinePairingError(error: string): void {
  currentState = {
    ...currentState,
    error,
    updatedAt: new Date().toISOString(),
  };
}

export function clearLinePairingState(): void {
  currentState = {
    pairingQrText: null,
    pairingQrSvg: null,
    pairingUrl: null,
    pincode: null,
    error: null,
    updatedAt: null,
  };
}

export function getLinePairingState(): LinePairingState {
  return { ...currentState };
}
