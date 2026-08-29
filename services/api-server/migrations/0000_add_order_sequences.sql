CREATE TYPE "public"."fraud_type_enum" AS ENUM('MOCK_LOCATION', 'VELOCITY_ANOMALY', 'ACCURACY_EXCESS', 'CLOCK_DRIFT');--> statement-breakpoint
CREATE TYPE "public"."attendance_type_enum" AS ENUM('OFFICE', 'CUSTOMER', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."user_label_enum" AS ENUM('SUPER_ADMIN', 'ADMIN_PUSAT', 'ADMIN_CABANG', 'SALESMAN', 'MR');--> statement-breakpoint
CREATE TYPE "public"."customer_type_enum" AS ENUM('OUTLET', 'DOCTOR', 'COMMUNITY', 'EVENT');--> statement-breakpoint
CREATE TYPE "public"."erp_system_enum" AS ENUM('SAP_S4HANA', 'SAP_ECC', 'QAD', 'CUSTOM_REST');--> statement-breakpoint
CREATE TYPE "public"."promo_type_enum" AS ENUM('PERCENT_DISCOUNT', 'FIXED_AMOUNT', 'FREE_GOODS', 'BUNDLING');--> statement-breakpoint
CREATE TYPE "public"."sync_status_enum" AS ENUM('PENDING', 'SYNCED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."visit_type_enum" AS ENUM('PLANNED', 'EXTRA');--> statement-breakpoint
CREATE TYPE "public"."order_status_enum" AS ENUM('DRAFT', 'SUBMITTED', 'SYNCED_ERP', 'REJECTED_ERP', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "audit_erp_sync_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"sync_direction" varchar(10) NOT NULL,
	"sync_type" varchar(50) NOT NULL,
	"endpoint_url" text NOT NULL,
	"http_method" varchar(10) DEFAULT 'POST',
	"request_payload" jsonb,
	"response_payload" jsonb,
	"http_status_code" integer,
	"latency_ms" integer,
	"retry_count" integer DEFAULT 0,
	"idempotency_key" uuid,
	"is_success" boolean DEFAULT false,
	"error_message" text,
	"error_code" varchar(100),
	"related_entity" varchar(50),
	"related_record_id" uuid,
	"bullmq_job_id" varchar(100),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "audit_fraud_telemetry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"fraud_type" "fraud_type_enum" NOT NULL,
	"severity" varchar(20) DEFAULT 'LOW',
	"claimed_lat" double precision,
	"claimed_lng" double precision,
	"claimed_accuracy_meters" double precision,
	"calculated_speed_kmh" double precision,
	"distance_from_target_meters" double precision,
	"client_timestamp" timestamp with time zone,
	"server_timestamp" timestamp with time zone DEFAULT now(),
	"mono_delta_ms" double precision,
	"clock_drift_seconds" double precision,
	"device_info" jsonb,
	"is_mock_provider" boolean DEFAULT false,
	"raw_payload" jsonb,
	"request_endpoint" varchar(255),
	"client_ip" varchar(45),
	"action_taken" varchar(50) DEFAULT 'SOFT_REJECT',
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "audit_mutation_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid,
	"entity_name" varchar(100) NOT NULL,
	"record_id" uuid NOT NULL,
	"action_type" varchar(10) NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb,
	"client_ip" varchar(45),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "audit_visit_lifecycle" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"step_name" varchar(50) NOT NULL,
	"step_timestamp" timestamp with time zone NOT NULL,
	"step_sequence" integer NOT NULL,
	"duration_from_prev_ms" integer,
	"geom" geometry(point),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "absensi" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"attendance_date" date NOT NULL,
	"attendance_type" "attendance_type_enum" NOT NULL,
	"check_in_time" timestamp with time zone NOT NULL,
	"check_in_geom" geometry(point) NOT NULL,
	"check_in_photo_s3_key" text NOT NULL,
	"check_in_distance_meters" integer,
	"check_out_time" timestamp with time zone,
	"check_out_geom" geometry(point),
	"check_out_photo_s3_key" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_user_attendance_date" UNIQUE("company_id","user_id","attendance_date")
);
--> statement-breakpoint
CREATE TABLE "app_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"soffice_id" uuid,
	"email" varchar(150) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"full_name" varchar(150) NOT NULL,
	"phone_number" varchar(30),
	"role_label" "user_label_enum" NOT NULL,
	"avatar_s3_key" text,
	"current_session_ip" varchar(45),
	"is_active" boolean DEFAULT true,
	"is_deleted" boolean DEFAULT false,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "app_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "user_lini_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"lini_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_user_lini" UNIQUE("company_id","user_id","lini_id")
);
--> statement-breakpoint
CREATE TABLE "doctor_outlet_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"doctor_customer_id" uuid NOT NULL,
	"outlet_customer_id" uuid NOT NULL,
	"room_or_department" varchar(100),
	"is_primary_practice" boolean DEFAULT false,
	"practice_days" varchar(50),
	"practice_hours_start" time,
	"practice_hours_end" time,
	"is_active" boolean DEFAULT true,
	"is_deleted" boolean DEFAULT false,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_doctor_outlet" UNIQUE("company_id","doctor_customer_id","outlet_customer_id")
);
--> statement-breakpoint
CREATE TABLE "doctor_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"sip_str_number" varchar(100),
	"specialization" varchar(100),
	"sub_specialization" varchar(100),
	"practice_schedule" jsonb,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "doctor_profiles_customer_id_unique" UNIQUE("customer_id")
);
--> statement-breakpoint
CREATE TABLE "master_customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"soffice_id" uuid NOT NULL,
	"customer_type" "customer_type_enum" DEFAULT 'OUTLET' NOT NULL,
	"erp_customer_code" varchar(100),
	"name" varchar(255) NOT NULL,
	"customer_group" varchar(100),
	"address" text,
	"city" varchar(100),
	"location_geom" geometry(point),
	"credit_limit" numeric(15, 2) DEFAULT '0',
	"credit_term_days" integer DEFAULT 30,
	"is_active" boolean DEFAULT true,
	"is_deleted" boolean DEFAULT false,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "master_pic" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"pic_name" varchar(150) NOT NULL,
	"position_title" varchar(100),
	"phone" varchar(50),
	"is_primary" boolean DEFAULT false,
	"is_deleted" boolean DEFAULT false,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(50) NOT NULL,
	"name" varchar(255) NOT NULL,
	"logo_s3_key" text,
	"erp_system_type" "erp_system_enum" DEFAULT 'SAP_S4HANA',
	"erp_endpoint_url" text,
	"erp_auth_config" jsonb,
	"erp_company_code" varchar(50),
	"default_tax_rate" numeric(5, 2) DEFAULT '11.00',
	"geofence_radius_meters" integer DEFAULT 100,
	"checkout_min_hour" integer DEFAULT 16,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "companies_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "master_lini" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" varchar(50) NOT NULL,
	"name" varchar(150) NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true,
	"is_deleted" boolean DEFAULT false,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "master_soffice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" varchar(50) NOT NULL,
	"name" varchar(150) NOT NULL,
	"address" text,
	"city" varchar(100),
	"location_geom" geometry(point),
	"is_active" boolean DEFAULT true,
	"is_deleted" boolean DEFAULT false,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "master_varian" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" varchar(50) NOT NULL,
	"name" varchar(150) NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true,
	"is_deleted" boolean DEFAULT false,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "master_material" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"erp_material_code" varchar(100) NOT NULL,
	"name" varchar(255) NOT NULL,
	"base_uom" varchar(20) NOT NULL,
	"sales_uom" varchar(20) NOT NULL,
	"nie" varchar(100),
	"valid_nie" date,
	"lini_id" uuid,
	"manufacture" varchar(255),
	"principal" varchar(255),
	"uom_conversion_rules" jsonb NOT NULL,
	"is_narcotic_psychotropic" boolean DEFAULT false,
	"is_active" boolean DEFAULT true,
	"is_deleted" boolean DEFAULT false,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "master_price" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"soffice_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"varian_id" uuid,
	"price_regular" numeric(15, 2) NOT NULL,
	"price_hja" numeric(15, 2),
	"price_het" numeric(15, 2),
	"per" integer DEFAULT 1 NOT NULL,
	"sales_uom" varchar(20) NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_price_branch_mat_var" UNIQUE("company_id","soffice_id","material_id","varian_id","valid_from")
);
--> statement-breakpoint
CREATE TABLE "master_promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"promo_code" varchar(100) NOT NULL,
	"promo_name" varchar(255) NOT NULL,
	"promo_type" "promo_type_enum" NOT NULL,
	"discount_percentage" numeric(5, 2) DEFAULT '0',
	"discount_amount" numeric(15, 2) DEFAULT '0',
	"min_order_qty" integer DEFAULT 1,
	"free_material_id" uuid,
	"free_material_qty" integer DEFAULT 0,
	"valid_start" timestamp with time zone NOT NULL,
	"valid_end" timestamp with time zone NOT NULL,
	"is_active" boolean DEFAULT true,
	"is_deleted" boolean DEFAULT false,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "stock_inventory_atp" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"soffice_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"varian_id" uuid,
	"batch" varchar(100) NOT NULL,
	"sled" date,
	"qty_available" numeric(12, 2) DEFAULT '0' NOT NULL,
	"qty_allocated" numeric(12, 2) DEFAULT '0' NOT NULL,
	"stock_value" numeric(15, 2) DEFAULT '0',
	"uom" varchar(20) NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_stock_batch" UNIQUE("company_id","soffice_id","material_id","varian_id","batch")
);
--> statement-breakpoint
CREATE TABLE "visit_agendas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visit_id" uuid NOT NULL,
	"topic" varchar(255) NOT NULL,
	"product_discussed_id" uuid,
	"discussion_summary" text,
	"photo_s3_key" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "visit_competitor_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visit_id" uuid NOT NULL,
	"competitor_brand" varchar(150) NOT NULL,
	"competitor_product" varchar(150) NOT NULL,
	"price_to_pharmacy" numeric(15, 2),
	"consumer_price" numeric(15, 2),
	"active_promo_notes" text,
	"photo_s3_key" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "visit_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"outlet_context_id" uuid,
	"plan_date" date NOT NULL,
	"is_lead_from_erp" boolean DEFAULT false,
	"is_approved" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_user_plan_target" UNIQUE("company_id","user_id","customer_id","outlet_context_id","plan_date")
);
--> statement-breakpoint
CREATE TABLE "visit_stock_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visit_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"physical_stock_qty" integer NOT NULL,
	"uom" varchar(20) NOT NULL,
	"estimated_days_of_stock" integer,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"outlet_id" uuid,
	"pic_id" uuid,
	"visit_type" "visit_type_enum" DEFAULT 'PLANNED',
	"visit_date" date NOT NULL,
	"visit_in_at" timestamp with time zone NOT NULL,
	"visit_in_geom" geometry(point) NOT NULL,
	"visit_in_distance_meters" integer,
	"visit_out_at" timestamp with time zone,
	"visit_out_geom" geometry(point),
	"signature_s3_key" text,
	"notes" text,
	"sync_status" "sync_status_enum" DEFAULT 'SYNCED',
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"uom" varchar(20) NOT NULL,
	"unit_price" numeric(15, 2) NOT NULL,
	"discount_percentage" numeric(5, 2) DEFAULT '0',
	"discount_amount" numeric(15, 2) DEFAULT '0',
	"subtotal" numeric(15, 2) NOT NULL,
	"promotion_id" uuid,
	"is_free_goods" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "order_sequences" (
	"company_id" uuid NOT NULL,
	"order_date" date NOT NULL,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "pk_order_sequences" PRIMARY KEY("company_id","order_date")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"soffice_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"doctor_customer_id" uuid,
	"visit_id" uuid,
	"order_number" varchar(100) NOT NULL,
	"erp_quotation_number" varchar(100),
	"order_date" date NOT NULL,
	"subtotal_amount" numeric(15, 2) NOT NULL,
	"total_discount_amount" numeric(15, 2) DEFAULT '0',
	"tax_rate" numeric(5, 2) DEFAULT '11.00',
	"tax_amount" numeric(15, 2) NOT NULL,
	"grand_total" numeric(15, 2) NOT NULL,
	"order_status" "order_status_enum" DEFAULT 'DRAFT',
	"erp_sync_timestamp" timestamp with time zone,
	"erp_error_payload" jsonb,
	"pdf_quotation_s3_key" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "orders_order_number_unique" UNIQUE("order_number")
);
--> statement-breakpoint
ALTER TABLE "audit_erp_sync_logs" ADD CONSTRAINT "audit_erp_sync_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_fraud_telemetry" ADD CONSTRAINT "audit_fraud_telemetry_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_fraud_telemetry" ADD CONSTRAINT "audit_fraud_telemetry_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_mutation_logs" ADD CONSTRAINT "audit_mutation_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_mutation_logs" ADD CONSTRAINT "audit_mutation_logs_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_visit_lifecycle" ADD CONSTRAINT "audit_visit_lifecycle_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_visit_lifecycle" ADD CONSTRAINT "audit_visit_lifecycle_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_visit_lifecycle" ADD CONSTRAINT "audit_visit_lifecycle_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absensi" ADD CONSTRAINT "absensi_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absensi" ADD CONSTRAINT "absensi_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_users" ADD CONSTRAINT "app_users_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_users" ADD CONSTRAINT "app_users_soffice_id_master_soffice_id_fk" FOREIGN KEY ("soffice_id") REFERENCES "public"."master_soffice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_lini_assignments" ADD CONSTRAINT "user_lini_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_lini_assignments" ADD CONSTRAINT "user_lini_assignments_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_lini_assignments" ADD CONSTRAINT "user_lini_assignments_lini_id_master_lini_id_fk" FOREIGN KEY ("lini_id") REFERENCES "public"."master_lini"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_outlet_assignments" ADD CONSTRAINT "doctor_outlet_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_outlet_assignments" ADD CONSTRAINT "doctor_outlet_assignments_doctor_customer_id_master_customer_id_fk" FOREIGN KEY ("doctor_customer_id") REFERENCES "public"."master_customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_outlet_assignments" ADD CONSTRAINT "doctor_outlet_assignments_outlet_customer_id_master_customer_id_fk" FOREIGN KEY ("outlet_customer_id") REFERENCES "public"."master_customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_outlet_assignments" ADD CONSTRAINT "doctor_outlet_assignments_deleted_by_app_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_profiles" ADD CONSTRAINT "doctor_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_profiles" ADD CONSTRAINT "doctor_profiles_customer_id_master_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."master_customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_customer" ADD CONSTRAINT "master_customer_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_customer" ADD CONSTRAINT "master_customer_soffice_id_master_soffice_id_fk" FOREIGN KEY ("soffice_id") REFERENCES "public"."master_soffice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_customer" ADD CONSTRAINT "master_customer_deleted_by_app_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_pic" ADD CONSTRAINT "master_pic_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_pic" ADD CONSTRAINT "master_pic_customer_id_master_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."master_customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_pic" ADD CONSTRAINT "master_pic_deleted_by_app_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_lini" ADD CONSTRAINT "master_lini_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_soffice" ADD CONSTRAINT "master_soffice_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_varian" ADD CONSTRAINT "master_varian_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_material" ADD CONSTRAINT "master_material_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_material" ADD CONSTRAINT "master_material_lini_id_master_lini_id_fk" FOREIGN KEY ("lini_id") REFERENCES "public"."master_lini"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_material" ADD CONSTRAINT "master_material_deleted_by_app_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_price" ADD CONSTRAINT "master_price_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_price" ADD CONSTRAINT "master_price_soffice_id_master_soffice_id_fk" FOREIGN KEY ("soffice_id") REFERENCES "public"."master_soffice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_price" ADD CONSTRAINT "master_price_material_id_master_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."master_material"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_price" ADD CONSTRAINT "master_price_varian_id_master_varian_id_fk" FOREIGN KEY ("varian_id") REFERENCES "public"."master_varian"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_promotions" ADD CONSTRAINT "master_promotions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_promotions" ADD CONSTRAINT "master_promotions_free_material_id_master_material_id_fk" FOREIGN KEY ("free_material_id") REFERENCES "public"."master_material"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_promotions" ADD CONSTRAINT "master_promotions_deleted_by_app_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_inventory_atp" ADD CONSTRAINT "stock_inventory_atp_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_inventory_atp" ADD CONSTRAINT "stock_inventory_atp_soffice_id_master_soffice_id_fk" FOREIGN KEY ("soffice_id") REFERENCES "public"."master_soffice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_inventory_atp" ADD CONSTRAINT "stock_inventory_atp_material_id_master_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."master_material"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_inventory_atp" ADD CONSTRAINT "stock_inventory_atp_varian_id_master_varian_id_fk" FOREIGN KEY ("varian_id") REFERENCES "public"."master_varian"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_agendas" ADD CONSTRAINT "visit_agendas_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_agendas" ADD CONSTRAINT "visit_agendas_product_discussed_id_master_material_id_fk" FOREIGN KEY ("product_discussed_id") REFERENCES "public"."master_material"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_competitor_audits" ADD CONSTRAINT "visit_competitor_audits_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_plans" ADD CONSTRAINT "visit_plans_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_plans" ADD CONSTRAINT "visit_plans_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_plans" ADD CONSTRAINT "visit_plans_customer_id_master_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."master_customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_plans" ADD CONSTRAINT "visit_plans_outlet_context_id_master_customer_id_fk" FOREIGN KEY ("outlet_context_id") REFERENCES "public"."master_customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_stock_audits" ADD CONSTRAINT "visit_stock_audits_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_stock_audits" ADD CONSTRAINT "visit_stock_audits_material_id_master_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."master_material"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_customer_id_master_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."master_customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_outlet_id_master_customer_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."master_customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_pic_id_master_pic_id_fk" FOREIGN KEY ("pic_id") REFERENCES "public"."master_pic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_material_id_master_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."master_material"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_promotion_id_master_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."master_promotions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_sequences" ADD CONSTRAINT "order_sequences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_soffice_id_master_soffice_id_fk" FOREIGN KEY ("soffice_id") REFERENCES "public"."master_soffice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_master_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."master_customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_doctor_customer_id_master_customer_id_fk" FOREIGN KEY ("doctor_customer_id") REFERENCES "public"."master_customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_erp_sync_company_date" ON "audit_erp_sync_logs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_erp_sync_direction" ON "audit_erp_sync_logs" USING btree ("company_id","sync_direction","sync_type","created_at");--> statement-breakpoint
CREATE INDEX "idx_erp_sync_failures" ON "audit_erp_sync_logs" USING btree ("company_id","is_success","created_at");--> statement-breakpoint
CREATE INDEX "idx_erp_sync_idempotency" ON "audit_erp_sync_logs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_erp_sync_related" ON "audit_erp_sync_logs" USING btree ("related_entity","related_record_id");--> statement-breakpoint
CREATE INDEX "idx_fraud_company_date" ON "audit_fraud_telemetry" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_fraud_user" ON "audit_fraud_telemetry" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_fraud_type" ON "audit_fraud_telemetry" USING btree ("company_id","fraud_type","created_at");--> statement-breakpoint
CREATE INDEX "idx_fraud_severity" ON "audit_fraud_telemetry" USING btree ("company_id","severity");--> statement-breakpoint
CREATE INDEX "idx_audit_mutation_company_date" ON "audit_mutation_logs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_mutation_entity" ON "audit_mutation_logs" USING btree ("company_id","entity_name","record_id");--> statement-breakpoint
CREATE INDEX "idx_audit_mutation_user" ON "audit_mutation_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_visit_lifecycle_visit" ON "audit_visit_lifecycle" USING btree ("visit_id","step_sequence");--> statement-breakpoint
CREATE INDEX "idx_visit_lifecycle_company_date" ON "audit_visit_lifecycle" USING btree ("company_id","step_timestamp");--> statement-breakpoint
CREATE INDEX "idx_visit_lifecycle_user" ON "audit_visit_lifecycle" USING btree ("user_id","step_timestamp");--> statement-breakpoint
CREATE INDEX "idx_absensi_company_date" ON "absensi" USING btree ("company_id","attendance_date");--> statement-breakpoint
CREATE INDEX "idx_users_company_soffice" ON "app_users" USING btree ("company_id","soffice_id");--> statement-breakpoint
CREATE INDEX "idx_users_role" ON "app_users" USING btree ("company_id","role_label");--> statement-breakpoint
CREATE INDEX "idx_user_lini_user" ON "user_lini_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_lini_lookup" ON "user_lini_assignments" USING btree ("company_id","user_id","lini_id");--> statement-breakpoint
CREATE INDEX "idx_doc_outlet_doc" ON "doctor_outlet_assignments" USING btree ("doctor_customer_id");--> statement-breakpoint
CREATE INDEX "idx_doc_outlet_outlet" ON "doctor_outlet_assignments" USING btree ("outlet_customer_id");--> statement-breakpoint
CREATE INDEX "idx_doctor_profile_specialization" ON "doctor_profiles" USING btree ("company_id","specialization");--> statement-breakpoint
CREATE INDEX "idx_customer_company" ON "master_customer" USING btree ("company_id","customer_type","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_customer_active_code" ON "master_customer" USING btree ("company_id","erp_customer_code");--> statement-breakpoint
CREATE INDEX "idx_pic_customer" ON "master_pic" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_lini_company" ON "master_lini" USING btree ("company_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lini_active_code" ON "master_lini" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "idx_soffice_company" ON "master_soffice" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_soffice_active_code" ON "master_soffice" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "idx_varian_company" ON "master_varian" USING btree ("company_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_varian_active_code" ON "master_varian" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "idx_material_company" ON "master_material" USING btree ("company_id","lini_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_material_active_code" ON "master_material" USING btree ("company_id","erp_material_code");--> statement-breakpoint
CREATE INDEX "idx_price_lookup" ON "master_price" USING btree ("soffice_id","material_id","varian_id","valid_from","valid_to");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_promo_active_code" ON "master_promotions" USING btree ("company_id","promo_code");--> statement-breakpoint
CREATE INDEX "idx_stock_lookup" ON "stock_inventory_atp" USING btree ("soffice_id","material_id","varian_id","sled");--> statement-breakpoint
CREATE INDEX "idx_visit_plan_lookup" ON "visit_plans" USING btree ("company_id","user_id","plan_date");--> statement-breakpoint
CREATE INDEX "idx_visits_company_date" ON "visits" USING btree ("company_id","visit_date");--> statement-breakpoint
CREATE INDEX "idx_visits_user" ON "visits" USING btree ("user_id","visit_date");--> statement-breakpoint
CREATE INDEX "idx_visits_customer_outlet" ON "visits" USING btree ("customer_id","outlet_id");--> statement-breakpoint
CREATE INDEX "idx_order_items_order" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_orders_company_status" ON "orders" USING btree ("company_id","order_status","order_date");