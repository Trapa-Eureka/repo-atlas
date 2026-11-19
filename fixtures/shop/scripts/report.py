from jobs import utils
from jobs.utils import Report, connection_url


def main(cursor):
    """Select the rows from the report and print them."""
    url = connection_url()
    cursor.execute("SELECT u.email, o.id FROM orders o JOIN users u ON u.id = o.user_id")
    Report().build()
    return utils.connection_url() or url
