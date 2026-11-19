module Returns
  class Store
    def initialize
      @rows = []
    end

    def find_order(id)
      execute("SELECT id, age_in_days FROM orders WHERE id = ?", id)
    end

    def record(order_id)
      execute("INSERT INTO returns (order_id) VALUES (?)", order_id)
    end

    private

    def execute(sql, *args)
      @rows << [sql, args]
      { age_in_days: 3 }
    end
  end
end
