export const PAYMENT_TYPE_CODES: Record<string, number> = {
  bank_transfer: 1,
  cash: 2,
  cod: 3,
  card: 4,
};
export function paymentTypeFromMethod(method?: string | null): number | undefined {
  if (!method) return undefined;
  return PAYMENT_TYPE_CODES[method];
}
