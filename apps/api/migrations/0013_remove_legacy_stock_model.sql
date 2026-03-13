DELETE FROM instrument_refs
WHERE instrument_id IN (
  SELECT instrument_id
  FROM instruments
  WHERE source_item_id LIKE 'binance-stock:%'
);

DELETE FROM instruments
WHERE source_item_id LIKE 'binance-stock:%';

DELETE FROM assets
WHERE asset_class = 'equity_exposure'
   OR asset_id LIKE 'ast:equity:%';

DELETE FROM market_shelf_cache
WHERE shelf_key = 'stocks';

DROP TABLE IF EXISTS asset_links;
