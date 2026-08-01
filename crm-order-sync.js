'use strict';

const { pool } = require('./db');

async function ensureCrmOrderSync() {
  await pool.query(`
    CREATE OR REPLACE FUNCTION sync_wholesale_order_to_crm()
    RETURNS TRIGGER AS $$
    DECLARE
      customer_record customers%ROWTYPE;
      account_id_value BIGINT;
    BEGIN
      SELECT * INTO customer_record FROM customers WHERE id=NEW.customer_id;
      IF customer_record.license_number IS NULL OR BTRIM(customer_record.license_number)='' THEN
        RETURN NEW;
      END IF;

      INSERT INTO crm_accounts(
        license_number,trade_name,legal_name,privilege_status,license_active,license_type,
        address1,address2,city,state,postal_code,phone,general_email,stage,priority,
        source_name,source_usage_basis
      ) VALUES(
        customer_record.license_number,customer_record.business_name,customer_record.business_name,
        'Customer supplied - verify',FALSE,'Cannabis Retailer',customer_record.ship_address1,
        customer_record.ship_address2,customer_record.city,customer_record.state,
        customer_record.postal_code,customer_record.phone,customer_record.email,'CUSTOMER','HIGH',
        'Wholesale order','Direct customer transaction'
      )
      ON CONFLICT(license_number) DO UPDATE SET
        trade_name=EXCLUDED.trade_name,
        address1=EXCLUDED.address1,
        address2=EXCLUDED.address2,
        city=EXCLUDED.city,
        state=EXCLUDED.state,
        postal_code=EXCLUDED.postal_code,
        phone=CASE WHEN EXCLUDED.phone<>'' THEN EXCLUDED.phone ELSE crm_accounts.phone END,
        general_email=CASE WHEN EXCLUDED.general_email<>'' THEN EXCLUDED.general_email ELSE crm_accounts.general_email END,
        stage='CUSTOMER',
        priority=CASE WHEN crm_accounts.priority='URGENT' THEN 'URGENT' ELSE 'HIGH' END,
        source_name=CASE WHEN crm_accounts.source_name='' THEN 'Wholesale order' ELSE crm_accounts.source_name END,
        source_usage_basis=CASE WHEN crm_accounts.source_usage_basis='' THEN 'Direct customer transaction' ELSE crm_accounts.source_usage_basis END,
        updated_at=NOW()
      RETURNING id INTO account_id_value;

      INSERT INTO crm_contacts(account_id,name,title,email,phone,is_primary,consent_source)
      VALUES(account_id_value,customer_record.contact_name,'Wholesale buyer',customer_record.email,customer_record.phone,TRUE,'')
      ON CONFLICT(account_id,email) DO UPDATE SET
        name=EXCLUDED.name,
        title=EXCLUDED.title,
        phone=EXCLUDED.phone,
        is_primary=TRUE,
        updated_at=NOW();

      UPDATE crm_contacts SET is_primary=FALSE
      WHERE account_id=account_id_value AND email IS DISTINCT FROM customer_record.email;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_sync_wholesale_order_to_crm ON orders;
    CREATE TRIGGER trg_sync_wholesale_order_to_crm
      AFTER INSERT ON orders
      FOR EACH ROW EXECUTE FUNCTION sync_wholesale_order_to_crm();
  `);
}

module.exports = { ensureCrmOrderSync };
