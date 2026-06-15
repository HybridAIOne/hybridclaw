export interface WhatsAppPairingState {
  pairingQrText: string | null;
  updatedAt: string | null;
  error: string | null;
}

let currentPairingState: WhatsAppPairingState = {
  pairingQrText: null,
  updatedAt: null,
  error: null,
};

export function setWhatsAppPairingQrText(pairingQrText: string): void {
  currentPairingState = {
    pairingQrText,
    updatedAt: new Date().toISOString(),
    error: null,
  };
}

export function setWhatsAppPairingError(error: string): void {
  currentPairingState = {
    pairingQrText: null,
    updatedAt: new Date().toISOString(),
    error,
  };
}

export function clearWhatsAppPairingState(): void {
  currentPairingState = {
    pairingQrText: null,
    updatedAt: null,
    error: null,
  };
}

export function getWhatsAppPairingState(): WhatsAppPairingState {
  return { ...currentPairingState };
}
