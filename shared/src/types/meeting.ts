export type MeetingRoom = {
  id: string;
  name: string;
  location: string | null;
  capacity: number | null;
  description: string | null;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
};

export type ReservationStatus = "CONFIRMED" | "CANCELLED";

export type ReservationParticipant = {
  developer_id: string;
  name: string | null;
  email: string | null;
};

export type MeetingReservation = {
  id: string;
  room_id: string;
  room_name: string | null;
  organizer_id: string | null;
  organizer_name: string | null;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string;
  status: ReservationStatus;
  participants: ReservationParticipant[];
  created_at: string | null;
  updated_at: string | null;
};

export type DirectoryUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
};

// 임직원 디렉토리 엔트리 — 회의 참석자 선택 등 people-picker 용.
// email 은 Slack 알림 대상 (company_email ?? personal_email).
export type DirectoryMember = {
  id: string;
  name: string;
  email: string | null;
  employment_type: string;
};
