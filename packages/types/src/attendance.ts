import type { AttendanceType } from './enums.js';
import type { GeoPoint } from './tenant.js';

/** Represents the `absensi` table — daily attendance record */
export interface Attendance {
  id: string;
  company_id: string;
  user_id: string;
  soffice_id: string;
  attendance_date: string;
  attendance_type: AttendanceType;
  check_in_at: string;
  check_in_geom: GeoPoint;
  check_in_accuracy_meters: number;
  check_in_distance_meters: number | null;
  check_in_photo_s3_key: string;
  check_in_mono_delta_ms: number;
  check_out_at: string | null;
  check_out_geom: GeoPoint | null;
  check_out_photo_s3_key: string | null;
  created_at: string;
  updated_at: string;
}
