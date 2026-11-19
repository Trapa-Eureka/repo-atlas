package com.acme.shipping.store;

public class ShipmentRepository {
    private final String zone;

    public ShipmentRepository(String zone) {
        this.zone = zone;
    }

    public void save(String orderId) {
        execute("INSERT INTO shipments (order_id, zone) VALUES (?, ?)", orderId, zone);
    }

    private void execute(String sql, String... args) {
    }
}
