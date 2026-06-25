// src/finaccount-mapper.js — Product categories → TRIVI finAccount codes

/** Maps product category to TRIVI finAccount code */
const FIN_ACCOUNT_MAP = {
  product:          '6010001',  // Výrobky
  service:          '6020001',  // Služby
  goods:            '6040001',  // Zboží
  shipping_product: '6013001',  // Doprava k výrobkům
  shipping_service: '6023001',  // Doprava ke službám
  shipping_goods:   '6043001',  // Doprava ke zboží
  discount_product: '6010002',  // Sleva výrobky
  discount_service: '6020002',  // Sleva služby
  discount_goods:   '6040002',  // Sleva zboží
  rounding:         '6480001',  // Haléřové vyrovnání
  fee:              '6020007',  // Poplatky (COD) — jen samostatně
  rental:           '6020008',  // Nájmy
  other_operating:  '6480007',  // Jiné provozní výnosy
  other_income:     '6490007',  // Ostatní výnosy
  financial:        '6683000',  // Ostatní finanční výnosy
};

/**
 * Classify a line item description into a product category.
 * @param {string} description
 * @param {{ hasProducts?: boolean, hasGoods?: boolean }} [context]
 * @returns {string} category key
 */
export function classifyCategory(description, context = {}) {
  const lower = description.toLowerCase();

  // Discounts
  if (lower.includes('sleva') || lower.includes('slevu') || lower.includes('discount')) {
    if (context.hasGoods) return 'discount_goods';
    if (context.hasProducts) return 'discount_product';
    return 'discount_service';
  }

  // Shipping / payment related
  if (lower.includes('doprav') || lower.includes('poštovn') || lower.includes('balné') ||
      lower.includes('dobírk') || lower.includes('platb') || lower.includes('kartou')) {
    if (context.hasGoods) return 'shipping_goods';
    if (context.hasProducts) return 'shipping_product';
    return 'shipping_service';
  }

  // Fees
  if (lower.includes('poplat') || lower.includes('cod')) return 'fee';
  // Rentals
  if (lower.includes('nájem') || lower.includes('pronájem')) return 'rental';
  // Rounding
  if (lower.includes('haléř') || lower.includes('zaokrouhl')) return 'rounding';
  // Goods
  if (context.hasGoods) return 'goods';
  // Products
  if (context.hasProducts) return 'product';
  // Default
  return 'service';
}

/**
 * Get finAccount code for a category. Defaults to 6020009 (other services).
 * @param {string} category
 * @returns {string}
 */
export function getFinAccount(category) {
  return FIN_ACCOUNT_MAP[category] || '6020009';
}

/**
 * Map extracted line items to TRIVI-ready format with finAccount codes.
 * @param {Array<{description:string, quantity:number, unitPrice:number, vatRate:number, category?:string}>} items
 * @returns {Array<Object>}
 */
export function mapLineItems(items) {
  return items.map(item => {
    const finAccount = item.category
      ? getFinAccount(item.category)
      : getFinAccount(classifyCategory(item.description));

    const total = item.quantity * item.unitPrice;
    const totalVatExcl = Math.round(total / (1 + item.vatRate / 100) * 100) / 100;
    const unitPriceVatExcl = Math.round(item.unitPrice / (1 + item.vatRate / 100) * 100) / 100;
    const vatRateType = item.vatRate === 0 ? 2 : 1; // 1=Standard, 2=OutOfVat

    return {
      description: item.description,
      finAccount,
      unitPrice: item.unitPrice,
      unitPriceVatExcl,
      unitName: 'ks',
      qt: item.quantity,
      total,
      totalVatExcl,
      vatRate: item.vatRate,
      vatRateType,
    };
  });
}

/**
 * Map payment type string to TRIVI numeric code.
 * @param {string} [type]
 * @returns {number} 1=BankTransfer, 2=Cash, 3=COD, 4=Card, 5=SetOff, 6=Loan
 */
export function mapPaymentType(type) {
  switch (type?.toLowerCase()) {
    case 'bank_transfer':
    case 'převodem':
      return 1;
    case 'cash':
    case 'hotově':
      return 2;
    case 'cod':
    case 'dobírka':
      return 3;
    case 'card':
    case 'kartou':
      return 4;
    case 'setoff':
    case 'zápočet':
      return 5;
    default:
      return 1; // Default: bank transfer
  }
}
