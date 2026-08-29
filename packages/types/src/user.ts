import type { BusinessLine, UserRole } from './enums.js';

/** Represents the `app_users` table */
export interface AppUser {
  id: string;
  company_id: string;
  soffice_id: string;
  email: string;
  full_name: string;
  phone: string | null;
  role_label: UserRole;
  business_line: BusinessLine;
  is_active: boolean;
  current_session_ip: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}
