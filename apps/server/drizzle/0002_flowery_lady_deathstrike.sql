CREATE TABLE "github_connections" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"github_user_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"token_ciphertext" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_git" (
	"vault_id" uuid PRIMARY KEY NOT NULL,
	"repo_url" text NOT NULL,
	"remote" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"deploy_key_ciphertext" "bytea" NOT NULL,
	"deploy_key_public" text NOT NULL,
	"deploy_key_id" bigint,
	"webhook_id" bigint,
	"webhook_secret_ciphertext" "bytea" NOT NULL,
	"base_commit" text,
	"status" text DEFAULT 'ok' NOT NULL,
	"status_detail" text,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled_by" uuid NOT NULL,
	"last_export_at" timestamp with time zone,
	"last_ingest_at" timestamp with time zone,
	"last_fetch_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_git" ADD CONSTRAINT "vault_git_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_git" ADD CONSTRAINT "vault_git_enabled_by_users_id_fk" FOREIGN KEY ("enabled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;