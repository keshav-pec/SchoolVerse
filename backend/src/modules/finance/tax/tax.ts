import type { PriceMode, TaxCalculationDTO } from '@shared';
import { formatMoney, percentOf, roundHalfUp } from '../core/money';

/**
 * TAX-03. A pure function: the same input always gives the same answer, with no database and no clock.
 *
 *   EXCLUSIVE   the price is before tax:  tax = price × rate, the payer pays price + tax
 *   INCLUSIVE   the price already holds tax: taxable = price ÷ (1 + rate), tax is the rest
 *
 * Inside the school's state the tax splits into CGST and SGST, half each (an odd paisa goes to CGST). Between states it is IGST.
 * A discount must be taken off BEFORE this is called, because a discount lowers the taxable value.
 */
export interface TaxInput {
  amountPaise: number;
  priceMode: PriceMode;
  rateBps: number;
  intraState: boolean;
}

const rateText = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

export function calculateTax(input: TaxInput): TaxCalculationDTO {
  const { amountPaise, priceMode, rateBps, intraState } = input;
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 0) throw new Error('The amount must be a whole number of paise.');
  const taxable = priceMode === 'INCLUSIVE' ? roundHalfUp(amountPaise * 10_000, 10_000 + rateBps) : amountPaise;
  const tax = priceMode === 'INCLUSIVE' ? amountPaise - taxable : percentOf(amountPaise, rateBps);
  const total = priceMode === 'INCLUSIVE' ? amountPaise : amountPaise + tax;
  const sgst = intraState ? Math.floor(tax / 2) : 0;
  const cgst = intraState ? tax - sgst : 0;
  const igst = intraState ? 0 : tax;
  const explanation =
    rateBps === 0 ? `${formatMoney(amountPaise)} (no GST)` : priceMode === 'INCLUSIVE' ? `${formatMoney(amountPaise)} includes ${rateText(rateBps)} GST ${formatMoney(tax)} (${formatMoney(taxable)} + ${formatMoney(tax)})` : `${formatMoney(amountPaise)} + ${rateText(rateBps)} GST ${formatMoney(tax)} = ${formatMoney(total)}`;
  return { amountPaise, priceMode, rateBps, intraState, taxableValuePaise: taxable, cgstPaise: cgst, sgstPaise: sgst, igstPaise: igst, taxPaise: tax, totalPaise: total, explanation };
}
