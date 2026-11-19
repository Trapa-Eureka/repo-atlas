package main

import (
	"fmt"
	"os"

	"example.com/shop/billing/invoice"
)

func main() {
	store := invoice.NewStore(os.Getenv("BILLING_REGION"))
	service := &invoice.Service{Store: store}
	total := service.Total("acme")
	fmt.Println(invoice.Format(total))
}
