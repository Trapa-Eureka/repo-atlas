package com.acme.shipping;

import com.acme.shipping.store.ShipmentRepository;

public class ShippingApp {
    public static void main(String[] args) {
        ShipmentRepository repository = new ShipmentRepository(System.getenv("SHIPPING_ZONE"));
        ShipmentService service = new ShipmentService(repository);
        System.out.println(service.ship("A-1"));
    }
}
