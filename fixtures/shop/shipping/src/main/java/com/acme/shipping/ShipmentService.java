package com.acme.shipping;

import com.acme.shipping.store.ShipmentRepository;

public class ShipmentService {
    private final ShipmentRepository repository;

    public ShipmentService(ShipmentRepository repository) {
        this.repository = repository;
    }

    public String ship(String orderId) {
        repository.save(orderId);
        return Labels.format(orderId);
    }
}
