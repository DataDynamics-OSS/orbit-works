export type MeUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
  created_at: string | null;
  /** 본인 매핑된 임직원 id. SUPER_ADMIN / 일부 ADMIN 은 null. */
  mapped_developer_id?: string | null;
};
