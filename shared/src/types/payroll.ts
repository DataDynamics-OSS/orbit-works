// 본인 급여명세서 모바일 뷰에서 사용되는 최소 필드.
// 백엔드 PayrollItemOut 의 일부만 노출한다.
export type MyPayrollItem = {
  id: string;
  run_id: string;
  year: number;
  month: number;
  pay_date: string | null;
  is_finalized: boolean;
  mode: "PAYROLL" | "WITHHOLDING";
  // 정규직/자사화
  base_salary: string | null;
  meal_allowance: string | null;
  bonus: string | null;
  gross_salary: string | null;
  national_pension: string | null;
  health_insurance: string | null;
  long_term_care: string | null;
  employment_insurance: string | null;
  income_tax: string | null;
  local_income_tax: string | null;
  total_deduction: string | null;
  net_pay: string | null;
  // 프리랜서
  freelancer_gross: string | null;
  withholding_tax: string | null;
  freelancer_net: string | null;
};
