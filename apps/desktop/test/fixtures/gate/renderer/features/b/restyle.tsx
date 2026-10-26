// FIXTURE - styling contracts (@shadcn/lint). Padded, Overlay, Resized and Tinted must fail
// no-restyle; Placed only places the button and passes.
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'

export const Placed = (): React.JSX.Element => <Button className="w-full mt-4">ok</Button>
export const Padded = (): React.JSX.Element => <Button className="p-4 rounded-full">no</Button>
export const Overlay = (): React.JSX.Element => (
  <Dialog>
    <DialogContent className="p-8 sm:max-w-3xl">no</DialogContent>
  </Dialog>
)
export const Resized = (): React.JSX.Element => (
  <Card>
    <CardTitle className="text-2xl font-bold">no</CardTitle>
  </Card>
)
export const Tinted = (): React.JSX.Element => <Badge className="shadow-lg">no</Badge>
