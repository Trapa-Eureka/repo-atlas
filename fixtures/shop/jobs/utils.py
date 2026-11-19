import os


def connection_url():
    return os.environ["DATABASE_URL"]


class Report:
    def build(self):
        return self.header()

    def header(self):
        return os.getenv("REPORT_TITLE", "Orders")
