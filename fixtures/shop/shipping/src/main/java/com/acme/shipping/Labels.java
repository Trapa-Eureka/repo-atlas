package com.acme.shipping;

final class Labels {
    private Labels() {
    }

    static String format(String orderId) {
        return "SHIP-" + orderId;
    }
}
