export const PAYMENT_TYPE_CODES = { bank_transfer: 1, cash: 2, cod: 3, card: 4 };

export function paymentTypeFromMethod(paymentMethod) {
  return PAYMENT_TYPE_CODES[paymentMethod];
}
