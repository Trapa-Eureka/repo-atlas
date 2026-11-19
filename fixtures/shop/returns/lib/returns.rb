require "json"
require "returns/policy"
require_relative "returns/store"

module Returns
  def self.process(order_id)
    store = Store.new
    order = store.find_order(order_id)
    return false unless Policy.allowed?(order)

    store.record(order_id)
    true
  end
end
